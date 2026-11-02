import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { manualPositions } from "@/db/schema";
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

const today = () => new Date().toISOString().slice(0, 10);

// A positive exact decimal, as a string, in canonical form.
const decimal = (what: string) =>
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

const symbol = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9.\-]+$/, "A symbol is letters and digits, like BTC")
  .transform((s) => s.toUpperCase());

const costBasis = z.number().int().min(0).max(1_000_000_000_00).nullable().optional();

/** The manual asset account a position belongs in; refuses a synced account or a liability. */
async function positionsAccount(db: Db, accountId: string) {
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
async function revalue(ctx: WriteContext, accountId: string, on: string) {
  const rows = await ctx.db.select().from(manualPositions).where(eq(manualPositions.accountId, accountId));
  const valueCents = rows.reduce((sum, p) => sum + positionValueCents(p.quantity, p.unitPrice), 0);
  await recordManualValue(ctx, accountId, valueCents, on);
}

export const addManualPosition = defineWrite({
  name: "holdings.addManual",
  description:
    "Add a position the owner keeps by hand to a manual asset account: a symbol (e.g. BTC), the quantity held and a " +
    "unit price with its date, as exact decimals, and optionally its total cost. The account's value becomes the sum " +
    "of its positions.",
  allowedActors: ["user"],
  input: z.object({
    accountId: z.uuid(),
    symbol,
    quantity: decimal("Quantity"),
    unitPrice: decimal("Price"),
    priceOn: valueDate.optional(),
    costBasisCents: costBasis,
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
    });
    await revalue(ctx, input.accountId, on);
    return { id: row.id };
  },
});

export const setManualQuantity = defineWrite({
  name: "holdings.setQuantity",
  description: "Change how much of a hand-entered position is held (an exact decimal), and optionally its total cost. Revalues its account.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), quantity: decimal("Quantity"), costBasisCents: costBasis, today: valueDate.optional() }),
  apply: async (ctx, { positionId, quantity, costBasisCents, today: day }) => {
    const row = await position(ctx.db, positionId);
    await ctx.update(manualPositions, positionId, { quantity, ...(costBasisCents !== undefined ? { costBasisCents } : {}) });
    await revalue(ctx, row.accountId, day ?? today());
    return { id: positionId };
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

export const removeManualPosition = defineWrite({
  name: "holdings.remove",
  description: "Remove a hand-entered position. Revalues its account without it.",
  allowedActors: ["user"],
  input: z.object({ positionId: z.uuid(), today: valueDate.optional() }),
  apply: async (ctx, { positionId, today: day }) => {
    const row = await position(ctx.db, positionId);
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
    valueCents: positionValueCents(p.quantity, p.unitPrice),
  }));
}
