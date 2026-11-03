import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, holdingSnapshots, manualPositions, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { difference, firstShortfall, holdingsOn, inOrder, SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { valueDate } from "@/operations/accounts";
import { defineWrite } from "@/operations/define";
import { assetClassInput, decimal, positionsAccount, revalue, symbol } from "@/operations/holdings";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// The trade log (#247): dated buys, sells and share transfers, so past
// holdings can be rebuilt by replaying them (#232).
//
// Two kinds of account take trades:
// - A manual asset account (#231): its trades are the source of its
//   positions. Every change replays them, sets each position's quantity to
//   what they add up to, and revalues the account. Selling more than was
//   held, on any day, is refused.
// - A synced brokerage or retirement account: trades only build the past.
//   Its positions still come from the sync, and tradeCheck below compares
//   the two, since a log typed by hand can miss a trade.
//
// Owner only, like positions, and no registered read: every read is one of
// Tally's tools, and trades say exactly what the owner holds. Outputs carry
// ids only.

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
 * For a manual account: replays its trades, refuses a sale of more than was
 * held, sets each symbol's position to what its trades add up to, and
 * revalues the account. A symbol new to the account takes its first price
 * from its trades, since a position needs one to be valued.
 */
async function followTrades(ctx: WriteContext, accountId: string, symbols: string[], on: string, assetClass: "crypto" | "equity" = "crypto") {
  const all = await ctx.db.select().from(trades).where(eq(trades.accountId, accountId));
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
    "and optionally the price per unit, as exact decimals. In a manual account, its positions follow its trades; " +
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

export const updateTrade = defineWrite({
  name: "trades.update",
  description: "Correct a trade's date, side, quantity or price (null clears the price). In a manual account, its positions follow.",
  allowedActors: ["user"],
  input: z.object({
    tradeId: z.uuid(),
    on: valueDate.optional(),
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
    await ctx.update(trades, tradeId, set);
    if (drivesPositions) await followTrades(ctx, row.accountId, [row.symbol], day ?? today());
    return { id: tradeId };
  },
});

export const removeTrade = defineWrite({
  name: "trades.remove",
  description: "Remove a trade. In a manual account, its positions follow.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid(), today: valueDate.optional() }),
  apply: async (ctx, { tradeId, today: day }) => {
    const row = await trade(ctx.db, tradeId);
    const { drivesPositions } = await tradeAccount(ctx.db, row.accountId);
    await ctx.remove(trades, tradeId);
    if (drivesPositions) await followTrades(ctx, row.accountId, [row.symbol], day ?? today());
    return { id: tradeId };
  },
});

export type TradeRow = { id: string; accountId: string; on: string; symbol: string; side: TradeSide; quantity: string; price: string | null; label: string };

/** Every trade, newest first, for the pages. Not an operation: see above. */
export async function listTrades(db: Db): Promise<TradeRow[]> {
  const rows = await db.select().from(trades).orderBy(desc(trades.on), desc(trades.createdAt));
  return rows.map((t) => ({ id: t.id, accountId: t.accountId, on: t.on, symbol: t.symbol, side: t.side, quantity: t.quantity, price: t.price, label: SIDE_LABELS[t.side] }));
}

export type TradeMismatch = { symbol: string; synced: string; traded: string; difference: string };

/**
 * For each synced account with trades: the symbols where replaying its trades
 * doesn't give the quantity its newest holdings snapshot reports, and by how
 * much (traded − synced). A missing or mistyped trade shows up here.
 */
export async function tradeCheck(db: Db): Promise<Map<string, TradeMismatch[]>> {
  const all = await db.select().from(trades);
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
