import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { manualPositions, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { isLiability } from "@/lib/net-worth";
import { normalizeQuantity, positionValueCents } from "@/lib/holdings/value";
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
    today: valueDate.optional(),
  }),
  apply: async (ctx, input) => {
    await positionsAccount(ctx.db, input.accountId);
    const on = input.today ?? today();
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
    await ctx.insert(trades, { accountId: input.accountId, on, symbol: input.symbol, side: "buy", quantity: input.quantity, price: input.unitPrice, source: "opening" });
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
    await revalue(ctx, row.accountId, on);
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
};

/** Every hand-entered position with its value, for the pages. Not an operation: see above. */
export async function listManualPositions(db: Db): Promise<ManualPosition[]> {
  const rows = await db.select().from(manualPositions).orderBy(manualPositions.symbol);
  return rows.map((p) => ({
    id: p.id,
    accountId: p.accountId,
    symbol: p.symbol,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    priceOn: p.priceOn,
    costBasisCents: p.costBasisCents,
    assetClass: p.assetClass,
    valueCents: positionValueCents(p.quantity, p.unitPrice),
  }));
}
