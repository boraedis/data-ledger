import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, commandLog, manualPositions, tradeHintDismissals, tradeKindMemory, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { difference, firstShortfall, holdingsOn, inOrder, SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { planCashRows } from "@/lib/trades/cash-plan";
import { priceFrom, recognize } from "@/lib/trades/cash-rows";
import { tradeKey } from "@/lib/trades/gaps";
import { planTradeGaps } from "@/lib/trades/plan";
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
//   a trade is missing, and trades.draftGaps below drafts it (#320, the
//   rules are in lib/trades/gaps.ts).
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
    "assetClass (crypto by default, or equity) is the kind of asset for a symbol new to the account. transactionId links the cash row it settled through.",
  allowedActors: ["user"],
  input: z.object({
    accountId: z.uuid(),
    on: valueDate,
    symbol,
    side: sides,
    quantity: decimal("Quantity"),
    price: decimal("Price").nullable().optional(),
    assetClass: assetClassInput.optional(),
    // The cash row it settled through, when the owner records one from a hint (#321).
    transactionId: z.uuid().optional(),
    today: valueDate.optional(),
  }),
  apply: async (ctx, input) => {
    const { drivesPositions } = await tradeAccount(ctx.db, input.accountId);
    if (input.transactionId) await cashRowFor(ctx.db, input.accountId, input.transactionId);
    const row = await ctx.insert(trades, {
      accountId: input.accountId,
      on: input.on,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price ?? null,
      transactionId: input.transactionId ?? null,
    });
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

export const draftGaps = defineWrite({
  name: "trades.draftGaps",
  description:
    "After a sync, for each synced investment account: record where trade drafting starts (its opening trades) the first time, " +
    "and afterwards draft a trade for each position whose synced quantity its trades don't explain. Cash and money-market " +
    "positions are left out. For the sync only.",
  allowedActors: ["import"],
  input: z.object({ accountId: z.uuid().optional() }),
  apply: async (ctx, { accountId }) => {
    let opening = 0;
    let drafted = 0;
    const pairs = new Map<string, string[]>();
    for (const plan of await planTradeGaps(ctx.db, accountId)) {
      if (plan.baseline) {
        await ctx.update(accounts, plan.accountId, { tradesBaselineOn: plan.baseline.on });
        for (const t of plan.baseline.opening) {
          // An opening counts like any confirmed trade. One for a position
          // with no symbol can't be confirmed (nothing to price or replay it
          // by), so it's kept dismissed: it still settles the gap, counts
          // nowhere else, and restoring it makes it a draft to name.
          await ctx.insert(trades, {
            accountId: plan.accountId,
            on: t.on,
            symbol: t.symbol,
            positionId: t.positionId,
            side: t.side,
            quantity: t.quantity,
            price: null,
            status: t.symbol ? "confirmed" : "dismissed",
            source: "opening",
          });
          opening++;
        }
      }
      for (const t of plan.drafts) {
        const row = await ctx.insert(trades, {
          accountId: plan.accountId,
          on: t.on,
          onFrom: t.onFrom,
          symbol: t.symbol,
          positionId: t.positionId,
          side: t.side,
          quantity: t.quantity,
          price: null,
          status: "draft",
          source: "position_gap",
          kind: t.kind,
          ratio: t.ratio,
        });
        if (t.pair) pairs.set(t.pair, [...(pairs.get(t.pair) ?? []), row.id]);
        drafted++;
      }
      // A waiting draft that turned out to be a new one's other end.
      for (const r of plan.relabel) {
        await ctx.update(trades, r.id, { side: r.side, kind: "transfer" });
        pairs.set(r.pair, [...(pairs.get(r.pair) ?? []), r.id]);
      }
    }
    // The two ends of each share transfer point at each other (#324).
    for (const [a, b] of pairs.values()) {
      await ctx.update(trades, a, { pairedTradeId: b });
      await ctx.update(trades, b, { pairedTradeId: a });
    }
    return { opening, drafted };
  },
});

/** A cash row in the account that no trade has yet, or an error saying why not. */
async function cashRowFor(db: Db, accountId: string, transactionId: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!row) throw new NotFoundError("Transaction not found");
  if (row.accountId !== accountId) throw new Error("That cash row is in another account");
  const [taken] = await db.select({ id: trades.id }).from(trades).where(eq(trades.transactionId, transactionId));
  if (taken) throw new Error("That cash row is already a trade's");
  return row;
}

/**
 * A cash row onto a draft (#321): its day, and the price its amount gives.
 * The day stays inside the draft's range (a row can post a few days after
 * the trade, and a draft dated after the snapshot it came from would leave
 * its gap open and be drafted again).
 */
async function attachRow(ctx: WriteContext, tradeId: string, transactionId: string) {
  const draft = await trade(ctx.db, tradeId);
  if (draft.status !== "draft") throw new Error("Only a draft takes a cash row");
  if (draft.kind === "split" || draft.kind === "transfer") throw new Error("A split or a share transfer has no cash row");
  if (draft.transactionId) throw new Error("That draft already has its cash row");
  const row = await cashRowFor(ctx.db, draft.accountId, transactionId);
  const seen = recognize({ id: row.id, accountId: row.accountId, postedOn: row.postedOn, amountCents: row.amountCents, text: [row.description, row.payee, row.memo].filter(Boolean).join(" ") });
  if (!seen || seen.side !== (draft.side === "sell" || draft.side === "transfer_out" ? "sell" : "buy")) throw new Error("That cash row isn't a " + (draft.side === "sell" ? "sale" : "buy"));
  const earliest = draft.onFrom ?? draft.on;
  const on = row.postedOn < earliest ? earliest : row.postedOn > draft.on ? draft.on : row.postedOn;
  await ctx.update(trades, tradeId, {
    transactionId,
    on,
    onFrom: null,
    price: priceFrom(row.amountCents, draft.quantity),
    ...(draft.symbol || !seen.symbol ? {} : { symbol: seen.symbol }),
    // Paid for by a dividend (#324).
    ...(seen.reinvestment ? { kind: "reinvestment" as const } : {}),
  });
}

export const attachCash = defineWrite({
  name: "trades.attachCash",
  description: "Attach a buy or sell cash row in an investment account to the draft trade it settled, giving the draft its day and price.",
  allowedActors: ["matcher", "user"],
  input: z.object({ tradeId: z.uuid(), transactionId: z.uuid() }),
  apply: async (ctx, { tradeId, transactionId }) => {
    await attachRow(ctx, tradeId, transactionId);
    return { id: tradeId };
  },
});

export const matchCash = defineWrite({
  name: "trades.matchCash",
  description: "After a sync: attach each buy or sell cash row to the one draft it fits, where each is the other's only fit. For the matcher only.",
  allowedActors: ["matcher"],
  input: z.object({}),
  apply: async (ctx) => {
    const { attach } = await planCashRows(ctx.db);
    for (const pair of attach) await attachRow(ctx, pair.tradeId, pair.transactionId);
    return { attached: attach.length };
  },
});

export const detachCash = defineWrite({
  name: "trades.detachCash",
  description: "Take a cash row off a draft trade, putting back the day, range and price the draft had before it.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid() }),
  apply: async (ctx, { tradeId }) => {
    const draft = await trade(ctx.db, tradeId);
    if (draft.status !== "draft") throw new Error("Only a draft's cash row can be taken off; edit a confirmed trade instead");
    if (!draft.transactionId) throw new Error("That draft has no cash row");
    // What it was before the cash row: from the command that attached it.
    const attaching = await ctx.db
      .select({ changes: commandLog.changes })
      .from(commandLog)
      .where(and(inArray(commandLog.operation, ["trades.attachCash", "trades.matchCash"]), eq(commandLog.status, "applied")))
      .orderBy(desc(commandLog.createdAt));
    const before = attaching
      .flatMap((c) => c.changes)
      .find((c) => c.table === "trades" && c.id === tradeId && c.before && (c.after as Record<string, unknown> | null)?.transaction_id === draft.transactionId)?.before as
      | { on: string; on_from: string | null; price: string | null; symbol: string | null; kind?: "trade" | "reinvestment" | "split" | "transfer" | "fee" }
      | undefined;
    await ctx.update(trades, tradeId, {
      transactionId: null,
      ...(before ? { on: before.on, onFrom: before.on_from, price: before.price, symbol: before.symbol, ...(before.kind ? { kind: before.kind } : {}) } : { price: null }),
    });
    return { id: tradeId };
  },
});

export const dismissHint = defineWrite({
  name: "trades.dismissHint",
  description: "Hide a buy or sell cash row from the Trades page's hints: it isn't a trade to record.",
  allowedActors: ["user"],
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const [row] = await ctx.db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, transactionId));
    if (!row) throw new NotFoundError("Transaction not found");
    const added = await ctx.insert(tradeHintDismissals, { transactionId });
    return { id: added.id };
  },
});

const kinds = z.enum(["trade", "reinvestment", "split", "transfer", "fee"]);

export const setTradeKind = defineWrite({
  name: "trades.setKind",
  description:
    "Say what kind of change in shares a trade is: a plain trade, a reinvested dividend, a split (with its ratio, new shares per old), " +
    "a transfer of shares between the owner's accounts, or a fee paid in shares. A reinvestment, fee or plain trade is remembered for " +
    "the account's position and side, so its next draft is made that kind.",
  allowedActors: ["user"],
  input: z.object({ tradeId: z.uuid(), kind: kinds, ratio: decimal("Ratio").optional() }),
  apply: async (ctx, { tradeId, kind, ratio }) => {
    const row = await trade(ctx.db, tradeId);
    if (row.status === "dismissed") throw new Error("Restore that trade before changing its kind");
    if (kind === "split" && !ratio) throw new Error("A split needs its ratio: new shares per old, like 2 for 2-for-1");
    if (row.kind === kind && (kind !== "split" || ratio === row.ratio)) throw new Error("It's already that kind");
    // Which way shares moved doesn't change; a transfer only names it differently.
    const inward = row.side === "buy" || row.side === "transfer_in";
    const side = kind === "transfer" ? (inward ? "transfer_in" : "transfer_out") : row.side.startsWith("transfer") ? (inward ? "buy" : "sell") : row.side;
    await ctx.update(trades, tradeId, { kind, side, ratio: kind === "split" ? ratio! : null, ...(kind !== "transfer" && row.pairedTradeId ? { pairedTradeId: null } : {}) });
    // Leaving a transfer: its other end isn't one either.
    if (kind !== "transfer" && row.pairedTradeId) {
      const other = await trade(ctx.db, row.pairedTradeId);
      const otherIn = other.side === "buy" || other.side === "transfer_in";
      await ctx.update(trades, other.id, { pairedTradeId: null, kind: "trade", side: otherIn ? "buy" : "sell" });
    }
    // Remembered for next time (#324), except the one-offs: a split or a transfer doesn't repeat by position.
    if (kind !== "split" && kind !== "transfer" && row.source === "position_gap") {
      const position = tradeKey(row);
      const memSide = inward ? "buy" : "sell";
      const [known] = await ctx.db
        .select()
        .from(tradeKindMemory)
        .where(and(eq(tradeKindMemory.accountId, row.accountId), eq(tradeKindMemory.position, position), eq(tradeKindMemory.side, memSide)));
      if (known) {
        if (known.kind !== kind) await ctx.update(tradeKindMemory, known.id, { kind });
      } else if (kind !== "trade") await ctx.insert(tradeKindMemory, { accountId: row.accountId, position, side: memSide, kind });
    }
    if (row.status === "confirmed") {
      const { drivesPositions } = await tradeAccount(ctx.db, row.accountId);
      if (drivesPositions) await followTrades(ctx, row.accountId, [row.symbol!], today());
    }
    return { id: tradeId };
  },
});

export const splitDraft = defineWrite({
  name: "trades.splitDraft",
  description:
    "Split one draft trade into several, when more than one trade happened between two syncs and they look like one net change. " +
    "The parts' quantities must add up to the draft's exactly; each may have its own day.",
  allowedActors: ["user"],
  input: z.object({
    tradeId: z.uuid(),
    parts: z.array(z.object({ quantity: decimal("Quantity"), on: valueDate.optional() })).min(2).max(20),
  }),
  apply: async (ctx, { tradeId, parts }) => {
    const row = await trade(ctx.db, tradeId);
    if (row.status !== "draft") throw new Error("Only a draft can be split");
    if (row.kind === "split" || row.kind === "transfer") throw new Error("A split or a share transfer can't be split into parts");
    const total = holdingsOn(parts.map((p) => ({ on: row.on, symbol: "x", side: "buy" as const, quantity: p.quantity }))).get("x") ?? "0";
    if (difference(total, row.quantity) !== "0") throw new Error(`The parts add up to ${total}, not ${row.quantity}`);
    for (const p of parts) if (p.on && (p.on > row.on || (row.onFrom && p.on < row.onFrom))) throw new Error("Each part's day has to be inside the draft's range");
    const dated = (p: (typeof parts)[number]) => (p.on ? { on: p.on, onFrom: null } : { on: row.on, onFrom: row.onFrom });
    const [first, ...rest] = parts;
    // The first part keeps the draft, and its cash row if it has one; the price was for the whole.
    await ctx.update(trades, tradeId, { quantity: first.quantity, ...dated(first), price: null });
    const ids = [tradeId];
    for (const p of rest) {
      const added = await ctx.insert(trades, {
        accountId: row.accountId,
        symbol: row.symbol,
        positionId: row.positionId,
        side: row.side,
        quantity: p.quantity,
        ...dated(p),
        price: null,
        status: "draft",
        source: row.source,
        kind: row.kind,
      });
      ids.push(added.id);
    }
    return { ids };
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
  kind: "trade" | "reinvestment" | "split" | "transfer" | "fee";
  ratio: string | null;
  pairedTradeId: string | null;
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
      kind: t.kind,
      ratio: t.ratio,
      pairedTradeId: t.pairedTradeId,
      label: SIDE_LABELS[t.side],
    }));
  },
});

/** How many drafts wait in all, for the Inbox, the Trades tab and Tally's summary (#325). A count, nothing more. */
export async function draftTotal(db: Db): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(trades).where(eq(trades.status, "draft"));
  return n;
}

/** How many drafts wait in each account, for the links into the Trades page. */
export async function draftCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ accountId: trades.accountId, n: count() }).from(trades).where(eq(trades.status, "draft")).groupBy(trades.accountId);
  return new Map(rows.map((r) => [r.accountId, r.n]));
}
