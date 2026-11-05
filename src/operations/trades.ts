import { and, count, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, holdingSnapshots, manualPositions, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { difference, firstShortfall, holdingsOn, inOrder, SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { valueDate } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { assetClassInput, decimal, positionsAccount, revalue, symbol } from "@/operations/holdings";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// The trade log (#247): dated buys, sells and share transfers, so past
// holdings can be rebuilt by replaying them (#232).
//
// A trade is a draft, confirmed or dismissed (#318). The owner's own trades
// are confirmed when entered. A draft is a trade inferred from what a sync
// reports and partly filled in (#320, #321): it may not know its symbol yet
// (only the position it came from), or its day (a range, on_from to on).
// Only confirmed trades count, anywhere: positions, value and history read
// them through lib/trades/confirmed.ts. Confirming needs a symbol and one
// day; a price is never required, since history is priced from daily prices.
//
// Two kinds of account take trades:
// - A manual asset account (#231): its confirmed trades are the source of
//   its positions. Every change to one replays them, sets each position's
//   quantity to what they add up to, and revalues the account. Selling more
//   than was held, on any day, is refused. Drafts here move nothing.
// - A synced brokerage or retirement account: its positions come from the
//   sync, and its confirmed trades build the past. Where the two disagree,
//   a trade is missing; tradeCheck below says so, until gap drafting (#320)
//   replaces it with drafts.
//
// Owner only, like positions, and never offered to Tally: drafting is for
// the sync and the matcher (and the owner), everything else for the owner.
// Its one read, trades.list, is for the Trades page (#319) and is
// restricted to the owner too, since trades say exactly what the owner
// holds and every unrestricted read is one of Tally's tools. Write outputs
// carry ids only.

const today = () => new Date().toISOString().slice(0, 10);
const sides = z.enum(["buy", "sell", "transfer_in", "transfer_out"]);

/** The account a trade can go in, and whether its trades drive its positions. */
async function tradeAccount(db: Db, accountId: string): Promise<{ drivesPositions: boolean }> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new NotFoundError("Account not found");
  if (account.source === "manual") {
    await positionsAccount(db, accountId);
    return { drivesPositions: true };
  }
  if (!(INVESTMENT_KINDS as readonly string[]).includes(account.type)) throw new Error("Trades go in a brokerage or retirement account, or a manual asset account");
  return { drivesPositions: false };
}

async function trade(db: Db, tradeId: string) {
  const [row] = await db.select().from(trades).where(eq(trades.id, tradeId));
  if (!row) throw new NotFoundError("Trade not found");
  return row;
}

/**
 * For a manual account: replays its confirmed trades, refuses a sale of more
 * than was held, sets each symbol's position to what they add up to, and
 * revalues the account. A symbol new to the account takes its first price
 * from its trades, since a position needs one to be valued.
 */
async function followTrades(ctx: WriteContext, accountId: string, symbols: string[], on: string, assetClass: "crypto" | "equity" = "crypto") {
  const all = await confirmedTrades(ctx.db, eq(trades.accountId, accountId));
  const short = firstShortfall(all);
  if (short) throw new Error(`That sells more ${short.symbol} than was held on ${short.on}`);
  const held = holdingsOn(all);
  for (const s of new Set(symbols)) {
    const quantity = held.get(s);
    const [existing] = await ctx.db
      .select()
      .from(manualPositions)
      .where(and(eq(manualPositions.accountId, accountId), sql`upper(${manualPositions.symbol}) = ${s}`));
    if (!quantity) {
      if (existing) await ctx.remove(manualPositions, existing.id);
    } else if (existing) {
      if (existing.quantity !== quantity) await ctx.update(manualPositions, existing.id, { quantity });
    } else {
      const priced = inOrder(all.filter((t) => t.symbol === s && t.price !== null)).at(-1);
      if (!priced) throw new Error(`Give a price for ${s}: it's new to this account, and needs one to be valued`);
      await ctx.insert(manualPositions, { accountId, symbol: s, quantity, unitPrice: priced.price!, priceOn: priced.on, costBasisCents: null, assetClass });
    }
  }
  await revalue(ctx, accountId, on);
}

export const addTrade = defineWrite({
  name: "trades.add",
  description:
    "Record a trade in an investment account: the date, a symbol, buy, sell, transfer in or transfer out, the quantity " +
    "and optionally the price per unit, as exact decimals. Recorded as confirmed. In a manual account, its positions follow its trades; " +
    "assetClass (crypto by default, or equity) is the kind of asset for a symbol new to the account.",
  allowedActors: ["user"],
  input: z.object({
    accountId: z.uuid(),
    on: valueDate,
    symbol,
    side: sides,
    quantity: decimal("Quantity"),
    price: decimal("Price").nullable().optional(),
    assetClass: assetClassInput.optional(),
    today: valueDate.optional(),
  }),
  apply: async (ctx, input) => {
    const { drivesPositions } = await tradeAccount(ctx.db, input.accountId);
    const row = await ctx.insert(trades, { accountId: input.accountId, on: input.on, symbol: input.symbol, side: input.side, quantity: input.quantity, price: input.price ?? null });
    if (drivesPositions) await followTrades(ctx, input.accountId, [input.symbol], input.today ?? today(), input.assetClass);
    return { id: row.id };
  },
});

export const draftTrade = defineWrite({
  name: "trades.draft",
  description:
    "Record a trade that was inferred rather than entered, as a draft for the owner to finish and confirm. It needs a side and a " +
    "quantity, and a symbol or the position it came from (positionId). Its day may be a range (onFrom to on). A draft counts nowhere " +
    "until confirmed. source says where it came from; transactionId is the cash row it settled through, when known.",
  allowedActors: ["import", "matcher", "user"],
  input: z
    .object({
      accountId: z.uuid(),
      on: valueDate,
      onFrom: valueDate.optional(),
      symbol: symbol.optional(),
      positionId: z.string().min(1).max(200).optional(),
      side: sides,
      quantity: decimal("Quantity"),
      price: decimal("Price").optional(),
      source: z.enum(["hand", "position_gap"]).default("position_gap"),
      transactionId: z.uuid().optional(),
    })
    .refine((d) => d.symbol || d.positionId, "A draft needs a symbol or the position it came from")
    .refine((d) => !d.onFrom || d.onFrom <= d.on, "A draft's range runs from its earliest day to its latest"),
  apply: async (ctx, input) => {
    await tradeAccount(ctx.db, input.accountId);
    const row = await ctx.insert(trades, {
      accountId: input.accountId,
      on: input.on,
      // A one-day range is one day.
      onFrom: input.onFrom && input.onFrom !== input.on ? input.onFrom : null,
      symbol: input.symbol ?? null,
      positionId: input.positionId ?? null,
      side: input.side,
      quantity: input.quantity,
      price: input.price ?? null,
      status: "draft",
      source: input.source,
      transactionId: input.transactionId ?? null,
    });
    return { id: row.id };
  },
});

export const updateTrade = defineWrite({
  name: "trades.update",
  description:
    "Correct a trade's date, side, quantity or price (null clears the price). On a draft, also its symbol and its range " +
    "(onFrom; null makes it one day). In a manual account, its positions follow a confirmed trade's change.",
  allowedActors: ["user"],
  input: z.object({
    tradeId: z.uuid(),
    on: valueDate.optional(),
    onFrom: valueDate.nullable().optional(),
    symbol: symbol.optional(),
    side: sides.optional(),
    quantity: decimal("Quantity").optional(),
    price: decimal("Price").nullable().optional(),
    today: valueDate.optional(),
  }),
  apply: async (ctx, { tradeId, today: day, ...changes }) => {
    const row = await trade(ctx.db, tradeId);
    const { drivesPositions } = await tradeAccount(ctx.db, row.accountId);
    const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) throw new Error("Nothing to change");
    // A confirmed trade's symbol and day are what replay keys on: fixing a
    // wrong symbol is removing it and adding the right one.
    if (row.status !== "draft" && ("symbol" in set || "onFrom" in set)) throw new Error("Only a draft's symbol and range can change");
    const on = (set.on as string | undefined) ?? row.on;
    const onFrom = "onFrom" in set ? (set.onFrom as string | null) : row.onFrom;
    if (onFrom && onFrom > on) throw new Error("A draft's range runs from its earliest day to its latest");
    if (onFrom === on) set.onFrom = null;
    await ctx.update(trades, tradeId, set);
    if (drivesPositions && row.status === "confirmed") await followTrades(ctx, row.accountId, [row.symbol!], day ?? today());
    return { id: tradeId };
  },
});

export const confirmTrade = defineWrite({
  name: "trades.confirm",
  description:
    "Confirm a draft trade, so it counts: in positions (for a manual account), value and history. It needs a symbol and one day; " +
    "a price isn't required.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid(), assetClass: assetClassInput.optional(), today: valueDate.optional() }),
  apply: async (ctx, { tradeId, assetClass, today: day }) => {
    const row = await trade(ctx.db, tradeId);
    if (row.status !== "draft") throw new Error(row.status === "confirmed" ? "That trade is already confirmed" : "Restore that trade before confirming it");
    if (!row.symbol) throw new Error("Give the trade a symbol before confirming it");
    if (row.onFrom) throw new Error("Pick the day it happened before confirming it");
    const { drivesPositions } = await tradeAccount(ctx.db, row.accountId);
    await ctx.update(trades, tradeId, { status: "confirmed" });
    if (drivesPositions) await followTrades(ctx, row.accountId, [row.symbol], day ?? today(), assetClass);
    return { id: tradeId };
  },
});

export const dismissTrade = defineWrite({
  name: "trades.dismiss",
  description: "Dismiss a draft trade that didn't happen. It's kept as dismissed, so the same difference isn't drafted again; restore brings it back.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid() }),
  apply: async (ctx, { tradeId }) => {
    const row = await trade(ctx.db, tradeId);
    if (row.status !== "draft") throw new Error("Only a draft can be dismissed");
    await ctx.update(trades, tradeId, { status: "dismissed" });
    return { id: tradeId };
  },
});

export const restoreTrade = defineWrite({
  name: "trades.restore",
  description: "Bring a dismissed trade back as a draft.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid() }),
  apply: async (ctx, { tradeId }) => {
    const row = await trade(ctx.db, tradeId);
    if (row.status !== "dismissed") throw new Error("Only a dismissed trade can be restored");
    await ctx.update(trades, tradeId, { status: "draft" });
    return { id: tradeId };
  },
});

export const removeTrade = defineWrite({
  name: "trades.remove",
  description: "Remove a trade. In a manual account, its positions follow a confirmed one's removal.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid(), today: valueDate.optional() }),
  apply: async (ctx, { tradeId, today: day }) => {
    const row = await trade(ctx.db, tradeId);
    const { drivesPositions } = await tradeAccount(ctx.db, row.accountId);
    await ctx.remove(trades, tradeId);
    if (drivesPositions && row.status === "confirmed") await followTrades(ctx, row.accountId, [row.symbol!], day ?? today());
    return { id: tradeId };
  },
});

export type TradeRow = {
  id: string;
  accountId: string;
  on: string;
  onFrom: string | null;
  symbol: string | null;
  positionId: string | null;
  side: TradeSide;
  quantity: string;
  price: string | null;
  status: "draft" | "confirmed" | "dismissed";
  source: "hand" | "opening" | "position_gap";
  transactionId: string | null;
  label: string;
};

const statuses = z.enum(["draft", "confirmed", "dismissed"]);

export const listTradesRead = defineRead({
  name: "trades.list",
  description:
    "Trades, newest first, for the owner's Trades page: drafts, confirmed and dismissed, optionally by account, status, symbol and " +
    "date range (on the trade's latest possible day). Owner only.",
  allowedActors: ["user"],
  input: z.object({
    accountId: z.uuid().optional(),
    status: statuses.optional(),
    symbol: z.string().trim().min(1).max(16).optional(),
    from: valueDate.optional(),
    to: valueDate.optional(),
    limit: z.number().int().min(1).max(1000).default(500),
  }),
  run: async (db, input): Promise<TradeRow[]> => {
    const rows = await db
      .select()
      .from(trades)
      .where(
        and(
          input.accountId ? eq(trades.accountId, input.accountId) : undefined,
          input.status ? eq(trades.status, input.status) : undefined,
          input.symbol ? eq(trades.symbol, input.symbol.toUpperCase()) : undefined,
          input.from ? gte(trades.on, input.from) : undefined,
          input.to ? lte(trades.on, input.to) : undefined,
        ),
      )
      .orderBy(desc(trades.on), desc(trades.createdAt))
      .limit(input.limit);
    return rows.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      on: t.on,
      onFrom: t.onFrom,
      symbol: t.symbol,
      positionId: t.positionId,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      status: t.status,
      source: t.source,
      transactionId: t.transactionId,
      label: SIDE_LABELS[t.side],
    }));
  },
});

/** How many drafts wait in each account, for the links into the Trades page. */
export async function draftCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ accountId: trades.accountId, n: count() }).from(trades).where(eq(trades.status, "draft")).groupBy(trades.accountId);
  return new Map(rows.map((r) => [r.accountId, r.n]));
}

export type TradeMismatch = { symbol: string; synced: string; traded: string; difference: string };

/**
 * For each synced account with trades: the symbols where replaying its
 * confirmed trades doesn't give the quantity its newest holdings snapshot
 * reports, and by how much (traded − synced). A missing or mistyped trade
 * shows up here. Replaced by gap drafting in #320.
 */
export async function tradeCheck(db: Db): Promise<Map<string, TradeMismatch[]>> {
  const all = await confirmedTrades(db);
  const accountIds = [...new Set(all.map((t) => t.accountId))];
  if (!accountIds.length) return new Map();
  const synced = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.id, accountIds), inArray(accounts.type, [...INVESTMENT_KINDS]), sql`${accounts.source} <> 'manual'`));
  const out = new Map<string, TradeMismatch[]>();
  for (const { id } of synced) {
    const [latest] = await db.select({ on: sql<string>`max(${holdingSnapshots.on})` }).from(holdingSnapshots).where(eq(holdingSnapshots.accountId, id));
    const reported = latest?.on
      ? await db
          .select({ symbol: sql<string>`upper(${holdingSnapshots.symbol})`, shares: holdingSnapshots.shares })
          .from(holdingSnapshots)
          .where(and(eq(holdingSnapshots.accountId, id), eq(holdingSnapshots.on, latest.on), isNotNull(holdingSnapshots.symbol)))
      : [];
    const syncedBy = new Map(reported.map((r) => [r.symbol, r.shares]));
    const traded = holdingsOn(all.filter((t) => t.accountId === id));
    const mismatches: TradeMismatch[] = [];
    for (const s of new Set([...syncedBy.keys(), ...traded.keys()])) {
      const a = traded.get(s) ?? "0";
      const b = syncedBy.get(s) ?? "0";
      const diff = difference(a, b);
      if (diff !== "0") mismatches.push({ symbol: s, synced: difference(b, "0"), traded: a, difference: diff });
    }
    if (mismatches.length) out.set(id, mismatches.sort((x, y) => x.symbol.localeCompare(y.symbol)));
  }
  return out;
}
