import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { dailyPrices, manualPositions, quotes, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { isLiability } from "@/lib/net-worth";
import { normalizeQuantity, positionValueCents } from "@/lib/holdings/value";
import { firstShortfall } from "@/lib/holdings/replay";
import { OWNER_PRICE_SOURCE } from "@/lib/prices/owner";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { defineWrite } from "@/operations/define";
import { manualAccount, recordManualValue, valueDate } from "@/operations/accounts";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Positions entered by hand (#231): crypto, say, until a connection covers
// it. They live in a manual account, which each change revalues as the sum
// of quantity × unit price and records as that day's value, exactly as a
// hand-entered value is recorded. So net worth and its history need nothing
// new, and undoing a change restores the value with the position.
//
// Owner only, like manual accounts: quantities and values never go to a
// model (AGENTS.md), and there is deliberately no registered read of them,
// since every read becomes one of Tally's tools. Pages read positions with
// listManualPositions below. Outputs carry ids only.
//
// Since the trade log (#247), every quantity here is what the account's
// confirmed trades add up to (#318): adding a position records an opening
// buy (source "opening"), and removing it removes its trades, drafts
// included. How much is held changes only by a trade (./trades.ts, recorded
// on the Trades page, #319): there was a second way, setting the quantity
// here, and it went so the two couldn't drift apart.
//
// The past (#340): a position can be held since a past day, which dates its
// opening trade, so the history rebuilt from trades (#232) starts there. A
// position the market price feed doesn't cover can take prices of the
// owner's own on past days (daily_prices, source "owner"), so its history
// isn't flat at today's price or missing.

const today = () => new Date().toISOString().slice(0, 10);

// A positive exact decimal, as a string, in canonical form.
export const decimal = (what: string) =>
  z
    .string()
    .transform((text, ctx) => {
      const n = normalizeQuantity(text);
      if (n === null || !/[1-9]/.test(n)) {
        ctx.addIssue({ code: "custom", message: `${what} should be a positive number like 0.5 or 1,250` });
        return z.NEVER;
      }
      return n;
    });

export const symbol = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9.\-]+$/, "A symbol is letters and digits, like BTC")
  .transform((s) => s.toUpperCase());

const costBasis = z.number().int().min(0).max(1_000_000_000_00).nullable().optional();

// Which source prices a position (#244): Coinbase for a coin, Tiingo for a
// stock, ETF or fund. Crypto unless said otherwise, as before this existed.
export const assetClassInput = z.enum(["crypto", "equity"]);

/** The manual asset account a position belongs in; refuses a synced account or a liability. */
export async function positionsAccount(db: Db, accountId: string) {
  const account = await manualAccount(db, accountId);
  if (isLiability(account.type)) throw new Error("Positions go in an asset account, not a loan or card");
  return account;
}

async function position(db: Db, positionId: string) {
  const [row] = await db.select().from(manualPositions).where(eq(manualPositions.id, positionId));
  if (!row) throw new NotFoundError("Position not found");
  return row;
}

/** Revalues the account from its positions and records it as the day's value. */
export async function revalue(ctx: WriteContext, accountId: string, on: string) {
  const rows = await ctx.db.select().from(manualPositions).where(eq(manualPositions.accountId, accountId));
  const valueCents = rows.reduce((sum, p) => sum + positionValueCents(p.quantity, p.unitPrice), 0);
  await recordManualValue(ctx, accountId, valueCents, on);
}

export const addManualPosition = defineWrite({
  name: "holdings.addManual",
  description:
    "Add a position the owner keeps by hand to a manual asset account: a symbol (e.g. BTC), the quantity held and a " +
    "unit price with its date, as exact decimals, and optionally its total cost. assetClass is crypto (a coin, the " +
    "default) or equity (a stock, ETF or fund), which decides where its market price comes from. The account's value " +
    "becomes the sum of its positions.",
  allowedActors: ["user"],
  input: z.object({
    accountId: z.uuid(),
    symbol,
    quantity: decimal("Quantity"),
    unitPrice: decimal("Price"),
    priceOn: valueDate.optional(),
    costBasisCents: costBasis,
    assetClass: assetClassInput.default("crypto"),
    // The day it's been held since (#340): its opening trade's date. Today when left out.
    heldSince: valueDate.optional(),
    today: valueDate.optional(),
  }),
  apply: async (ctx, input) => {
    await positionsAccount(ctx.db, input.accountId);
    const on = input.today ?? today();
    if (input.heldSince && input.heldSince > on) throw new Error("A position can't be held since a day after today");
    const [existing] = await ctx.db
      .select({ id: manualPositions.id })
      .from(manualPositions)
      .where(and(eq(manualPositions.accountId, input.accountId), sql`upper(${manualPositions.symbol}) = ${input.symbol}`));
    if (existing) throw new Error(`${input.symbol} is already in this account; change its quantity instead`);
    const row = await ctx.insert(manualPositions, {
      accountId: input.accountId,
      symbol: input.symbol,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      priceOn: input.priceOn ?? on,
      costBasisCents: input.costBasisCents ?? null,
      assetClass: input.assetClass,
    });
    // The opening trade (#247), so the position is what its trades add up to.
    await ctx.insert(trades, { accountId: input.accountId, on: input.heldSince ?? on, symbol: input.symbol, side: "buy", quantity: input.quantity, price: input.unitPrice, source: "opening" });
    // The owner's price is a dated price too, where nothing else prices it.
    await recordOwnerPrice(ctx, input.assetClass, input.symbol, input.priceOn ?? on, input.unitPrice);
    await revalue(ctx, input.accountId, on);
    return { id: row.id };
  },
});

export const setManualPrice = defineWrite({
  name: "holdings.setPrice",
  description: "Set a hand-entered position's unit price (an exact decimal) and the date it's from. Revalues its account.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), unitPrice: decimal("Price"), priceOn: valueDate.optional(), today: valueDate.optional() }),
  apply: async (ctx, { positionId, unitPrice, priceOn, today: day }) => {
    const row = await position(ctx.db, positionId);
    const on = day ?? today();
    await ctx.update(manualPositions, positionId, { unitPrice, priceOn: priceOn ?? on });
    await recordOwnerPrice(ctx, row.assetClass, row.symbol.toUpperCase(), priceOn ?? on, unitPrice);
    await revalue(ctx, row.accountId, on);
    return { id: positionId };
  },
});

/** Whether the market price feed prices this symbol: a quote with a price, or a close it recorded. */
async function marketCovers(db: Db, assetClass: "crypto" | "equity", symbol: string): Promise<boolean> {
  const [quoted] = await db
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.assetClass, assetClass), eq(quotes.symbol, symbol), isNotNull(quotes.price)))
    .limit(1);
  if (quoted) return true;
  const [closed] = await db
    .select({ id: dailyPrices.id })
    .from(dailyPrices)
    .where(and(eq(dailyPrices.assetClass, assetClass), eq(dailyPrices.symbol, symbol), ne(dailyPrices.source, OWNER_PRICE_SOURCE)))
    .limit(1);
  return Boolean(closed);
}

/**
 * The owner's price for a day, kept for history (#340), but only where the
 * market feed doesn't price the symbol: its closes are what history uses,
 * and an owner's price early on would stop it backfilling earlier ones.
 */
async function recordOwnerPrice(ctx: WriteContext, assetClass: "crypto" | "equity", symbol: string, on: string, price: string) {
  if (await marketCovers(ctx.db, assetClass, symbol)) return false;
  const [existing] = await ctx.db
    .select()
    .from(dailyPrices)
    .where(and(eq(dailyPrices.assetClass, assetClass), eq(dailyPrices.symbol, symbol), eq(dailyPrices.on, on)));
  if (existing) {
    if (existing.price !== price || existing.source !== OWNER_PRICE_SOURCE) await ctx.update(dailyPrices, existing.id, { price, source: OWNER_PRICE_SOURCE });
  } else await ctx.insert(dailyPrices, { assetClass, symbol, on, price, source: OWNER_PRICE_SOURCE });
  return true;
}

/** A position's opening trade: the one marked as such, else (from before #320) its earliest buy. */
async function openingTrade(db: Db, accountId: string, symbol: string) {
  const own = await confirmedTrades(db, and(eq(trades.accountId, accountId), eq(trades.symbol, symbol)));
  const buys = own.filter((t) => t.side === "buy" || t.side === "transfer_in").sort((a, b) => a.on.localeCompare(b.on) || a.createdAt.getTime() - b.createdAt.getTime());
  return { opening: own.find((t) => t.source === "opening") ?? buys[0] ?? null, all: own };
}

export const setHeldSince = defineWrite({
  name: "holdings.setHeldSince",
  description:
    "Say since when a hand-entered position has been held: moves its opening trade to that day, so its history starts there. " +
    "Its quantity today doesn't change.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), heldSince: valueDate }),
  apply: async (ctx, { positionId, heldSince }) => {
    const row = await position(ctx.db, positionId);
    const symbol = row.symbol.toUpperCase();
    const { opening, all } = await openingTrade(ctx.db, row.accountId, symbol);
    if (!opening) throw new NotFoundError(`${symbol} has no opening trade to date`);
    if (opening.on === heldSince) throw new Error(`It's already held since ${heldSince}`);
    // Later than a sale that it paid for would sell what wasn't held yet.
    const short = firstShortfall(all.map((t) => (t.id === opening.id ? { ...t, on: heldSince } : t)));
    if (short) throw new Error(`That's after a sale on ${short.on}, which needs it held by then; pick ${short.on} or earlier`);
    await ctx.update(trades, opening.id, { on: heldSince });
    return { id: positionId };
  },
});

export const setPastPrice = defineWrite({
  name: "holdings.setPastPrice",
  description:
    "Give a hand-entered position the owner's price on a past day, for a symbol the market price feed doesn't cover, so its " +
    "history is valued from it until the next one. A second price for the same day replaces the first.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), on: valueDate, price: decimal("Price") }),
  apply: async (ctx, { positionId, on, price }) => {
    const row = await position(ctx.db, positionId);
    const recorded = await recordOwnerPrice(ctx, row.assetClass, row.symbol.toUpperCase(), on, price);
    if (!recorded) throw new Error(`${row.symbol.toUpperCase()} has market prices; its history uses those`);
    return { id: positionId };
  },
});

export const removePastPrice = defineWrite({
  name: "holdings.removePastPrice",
  description: "Remove the owner's price for a hand-entered position on a past day.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), on: z.iso.date() }),
  apply: async (ctx, { positionId, on }) => {
    const row = await position(ctx.db, positionId);
    const [existing] = await ctx.db
      .select({ id: dailyPrices.id })
      .from(dailyPrices)
      .where(and(eq(dailyPrices.assetClass, row.assetClass), eq(dailyPrices.symbol, row.symbol.toUpperCase()), eq(dailyPrices.on, on), eq(dailyPrices.source, OWNER_PRICE_SOURCE)));
    if (!existing) throw new NotFoundError(`No price of yours for ${on}`);
    await ctx.remove(dailyPrices, existing.id);
    return { id: positionId };
  },
});

export const setManualAssetClass = defineWrite({
  name: "holdings.setAssetClass",
  description: "Say what kind of asset a hand-entered position is: crypto (a coin) or equity (a stock, ETF or fund). This decides where its market price comes from.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), assetClass: assetClassInput }),
  apply: async (ctx, { positionId, assetClass }) => {
    const row = await position(ctx.db, positionId);
    if (row.assetClass === assetClass) throw new Error("It's already that kind of asset");
    await ctx.update(manualPositions, positionId, { assetClass });
    return { id: positionId };
  },
});

export const removeManualPosition = defineWrite({
  name: "holdings.remove",
  description: "Remove a hand-entered position, and its trades: for one entered by mistake. Revalues its account without it.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), today: valueDate.optional() }),
  apply: async (ctx, { positionId, today: day }) => {
    const row = await position(ctx.db, positionId);
    const own = await ctx.db
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.accountId, row.accountId), eq(trades.symbol, row.symbol.toUpperCase())));
    for (const t of own) await ctx.remove(trades, t.id);
    await ctx.remove(manualPositions, positionId);
    await revalue(ctx, row.accountId, day ?? today());
    return { id: positionId };
  },
});

export type ManualPosition = {
  id: string;
  accountId: string;
  symbol: string;
  quantity: string;
  unitPrice: string;
  priceOn: string;
  costBasisCents: number | null;
  assetClass: "crypto" | "equity";
  valueCents: number;
  // Its opening trade's day (#340), or null without one.
  heldSince: string | null;
  // The owner's own prices on past days, oldest first, where the market feed doesn't price it.
  pastPrices: { on: string; price: string }[];
};

/** Every hand-entered position with its value, for the pages. Not an operation: see above. */
export async function listManualPositions(db: Db): Promise<ManualPosition[]> {
  const rows = await db.select().from(manualPositions).orderBy(manualPositions.symbol);
  if (!rows.length) return [];
  const symbols = [...new Set(rows.map((p) => p.symbol.toUpperCase()))];
  const [held, owned] = await Promise.all([
    confirmedTrades(db, inArray(trades.accountId, [...new Set(rows.map((p) => p.accountId))])),
    db
      .select({ assetClass: dailyPrices.assetClass, symbol: dailyPrices.symbol, on: dailyPrices.on, price: dailyPrices.price })
      .from(dailyPrices)
      .where(and(eq(dailyPrices.source, OWNER_PRICE_SOURCE), inArray(dailyPrices.symbol, symbols)))
      .orderBy(dailyPrices.on),
  ]);
  return rows.map((p) => {
    const symbol = p.symbol.toUpperCase();
    const own = held.filter((t) => t.accountId === p.accountId && t.symbol === symbol);
    const opening = own.find((t) => t.source === "opening") ?? own.filter((t) => t.side === "buy" || t.side === "transfer_in").sort((a, b) => a.on.localeCompare(b.on))[0];
    return {
      id: p.id,
      accountId: p.accountId,
      symbol: p.symbol,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      priceOn: p.priceOn,
      costBasisCents: p.costBasisCents,
      assetClass: p.assetClass,
      valueCents: positionValueCents(p.quantity, p.unitPrice),
      heldSince: opening?.on ?? null,
      pastPrices: owned.filter((o) => o.assetClass === p.assetClass && o.symbol === symbol).map((o) => ({ on: o.on, price: o.price })),
    };
  });
}
