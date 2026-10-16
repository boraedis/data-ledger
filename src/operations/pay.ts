import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { categories, payLineKind, payStubLines, payStubs, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { DEPOSIT_DAYS_AFTER, DEPOSIT_DAYS_BEFORE, depositCandidates, groupOf, stubMismatch, type PayLineGroup } from "@/lib/pay/stubs";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Pay stubs (#60): each pay period's gross pay, what was withheld and the
// net that reached the bank, so the ledger knows what a paycheck really
// was, not just the deposit. Amounts and labels only.

const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

const line = z.object({
  kind: z.enum(payLineKind.enumValues),
  label: z.string().trim().min(1).max(60),
  amountCents: z.number().int().min(1),
  categoryId: z.uuid().nullable().optional(),
});

const stubFields = z.object({
  employer: z.string().trim().min(1).max(60),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  payDate: z.iso.date(),
  grossCents: z.number().int().min(1),
  netCents: z.number().int().min(0),
  lines: z.array(line).max(30),
  // Omitted: link the deposit automatically if exactly one fits. Null: no
  // link. An id: that deposit, which must be the net pay.
  depositTransactionId: z.uuid().nullable().optional(),
});

/** Posted deposits near the pay date for exactly the net, not already another stub's. */
export async function openDeposits(db: Db, stub: { payDate: string; netCents: number }, exceptStubId?: string) {
  const linked = db
    .select({ id: payStubs.depositTransactionId })
    .from(payStubs)
    .where(and(isNotNull(payStubs.depositTransactionId), exceptStubId ? ne(payStubs.id, exceptStubId) : undefined));
  const rows = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.amountCents, stub.netCents),
        eq(transactions.pending, false),
        isNull(transactions.provisionalSource),
        gte(transactions.postedOn, shift(stub.payDate, -DEPOSIT_DAYS_BEFORE)),
        lte(transactions.postedOn, shift(stub.payDate, DEPOSIT_DAYS_AFTER)),
        notInArray(transactions.id, linked),
      ),
    );
  return depositCandidates(stub, rows);
}

async function checkDeposit(ctx: WriteContext, depositId: string, stub: { payDate: string; netCents: number }, exceptStubId?: string) {
  const [deposit] = await ctx.db.select().from(transactions).where(eq(transactions.id, depositId));
  if (!deposit) throw new NotFoundError("Deposit not found");
  // A pending or provisional row is replaced when the bank settles it; the
  // link would quietly fall off.
  if (deposit.pending || deposit.provisionalSource) throw new Error("Link the deposit once the bank has posted it");
  if (deposit.amountCents !== stub.netCents) throw new Error("The deposit must be exactly the net pay");
  if (deposit.isSplit) throw new Error("That deposit is split; unsplit it first, since the pay stub says what it's made of");
  const [other] = await ctx.db
    .select({ id: payStubs.id })
    .from(payStubs)
    .where(and(eq(payStubs.depositTransactionId, depositId), exceptStubId ? ne(payStubs.id, exceptStubId) : undefined));
  if (other) throw new Error("That deposit is already another pay stub's net pay");
}

async function validate(ctx: WriteContext, input: z.infer<typeof stubFields>) {
  if (input.periodEnd < input.periodStart) throw new Error("The pay period ends before it starts");
  const mismatch = stubMismatch(input.grossCents, input.lines, input.netCents);
  if (mismatch) throw new Error(mismatch);
  const categoryIds = [...new Set(input.lines.map((l) => l.categoryId).filter((id): id is string => Boolean(id)))];
  if (categoryIds.length) {
    const found = await ctx.db.select({ id: categories.id }).from(categories).where(inArray(categories.id, categoryIds));
    if (found.length !== categoryIds.length) throw new NotFoundError("Category not found");
  }
}

async function resolveDeposit(ctx: WriteContext, input: z.infer<typeof stubFields>, exceptStubId?: string): Promise<string | null> {
  if (input.depositTransactionId === null) return null;
  if (input.depositTransactionId) {
    await checkDeposit(ctx, input.depositTransactionId, input, exceptStubId);
    return input.depositTransactionId;
  }
  // Only an unambiguous match is linked automatically.
  const candidates = await openDeposits(ctx.db, input, exceptStubId);
  return candidates.length === 1 ? candidates[0].id : null;
}

async function writeLines(ctx: WriteContext, payStubId: string, lines: z.infer<typeof line>[]) {
  for (const [position, l] of lines.entries()) {
    await ctx.insert(payStubLines, { payStubId, kind: l.kind, label: l.label, amountCents: l.amountCents, categoryId: l.categoryId ?? null, position });
  }
}

export const createPayStub = defineWrite({
  name: "payStubs.create",
  description:
    "Record a pay stub: employer label, pay period, pay date, gross pay, each deduction (kind, the stub's label, " +
    "positive cents, optionally the category it counts under in budgets) and net pay. Gross minus deductions must " +
    "equal net exactly. The net-pay deposit is linked automatically when exactly one posted deposit matches; then " +
    "budgets count gross pay and each deduction instead of the net.",
  input: stubFields,
  apply: async (ctx, input) => {
    await validate(ctx, input);
    const depositTransactionId = await resolveDeposit(ctx, input);
    const { lines, ...fields } = input;
    const row = await ctx.insert(payStubs, { ...fields, depositTransactionId });
    await writeLines(ctx, row.id, lines);
    return { payStubId: row.id, depositTransactionId };
  },
});

export const updatePayStub = defineWrite({
  name: "payStubs.update",
  description: "Replace a pay stub's details and deductions (same fields and checks as payStubs.create).",
  input: stubFields.extend({ payStubId: z.uuid() }),
  apply: async (ctx, { payStubId, ...input }) => {
    const [existing] = await ctx.db.select().from(payStubs).where(eq(payStubs.id, payStubId));
    if (!existing) throw new NotFoundError("Pay stub not found");
    await validate(ctx, input);
    // Omitted: keep the current link if the deposit still fits the
    // (possibly edited) net, else look again.
    let depositTransactionId: string | null;
    if (input.depositTransactionId === undefined && existing.depositTransactionId) {
      const [still] = await ctx.db.select({ amountCents: transactions.amountCents }).from(transactions).where(eq(transactions.id, existing.depositTransactionId));
      depositTransactionId = still?.amountCents === input.netCents ? existing.depositTransactionId : await resolveDeposit(ctx, input, payStubId);
    } else {
      depositTransactionId = await resolveDeposit(ctx, input, payStubId);
    }
    const { lines, ...fields } = input;
    await ctx.update(payStubs, payStubId, { ...fields, depositTransactionId });
    const old = await ctx.db.select({ id: payStubLines.id }).from(payStubLines).where(eq(payStubLines.payStubId, payStubId));
    for (const l of old) await ctx.remove(payStubLines, l.id);
    await writeLines(ctx, payStubId, lines);
    return { payStubId, depositTransactionId };
  },
});

export const deletePayStub = defineWrite({
  name: "payStubs.delete",
  description: "Delete a pay stub and its deductions. Its deposit counts as plain net pay again.",
  input: z.object({ payStubId: z.uuid() }),
  apply: async (ctx, { payStubId }) => {
    const [existing] = await ctx.db.select({ id: payStubs.id }).from(payStubs).where(eq(payStubs.id, payStubId));
    if (!existing) throw new NotFoundError("Pay stub not found");
    // Lines through tracked writes first: the cascade would remove them
    // where undo can't see.
    const lines = await ctx.db.select({ id: payStubLines.id }).from(payStubLines).where(eq(payStubLines.payStubId, payStubId));
    for (const l of lines) await ctx.remove(payStubLines, l.id);
    await ctx.remove(payStubs, payStubId);
    return { deleted: 1 };
  },
});

export const linkPayDeposit = defineWrite({
  name: "payStubs.linkDeposit",
  description: "Link a pay stub to the bank deposit of its net pay (exactly the net amount), or unlink it (null).",
  input: z.object({ payStubId: z.uuid(), depositTransactionId: z.uuid().nullable() }),
  apply: async (ctx, { payStubId, depositTransactionId }) => {
    const [stub] = await ctx.db.select().from(payStubs).where(eq(payStubs.id, payStubId));
    if (!stub) throw new NotFoundError("Pay stub not found");
    if (depositTransactionId) await checkDeposit(ctx, depositTransactionId, stub, payStubId);
    if (stub.depositTransactionId !== depositTransactionId) await ctx.update(payStubs, payStubId, { depositTransactionId });
    return { payStubId, depositTransactionId };
  },
});

export const listPayStubs = defineRead({
  name: "payStubs.list",
  description:
    "Pay stubs, newest pay date first, optionally for one calendar year: employer label, period, pay date, gross, " +
    "net, each deduction (kind, group: tax / insurance / retirement / other, label, amount, category), totals per " +
    "group, and the linked net-pay deposit if any. Amounts are integer cents.",
  input: z.object({ year: z.number().int().min(2000).max(2100).optional() }),
  run: async (db, { year }) => {
    const stubs = await db
      .select()
      .from(payStubs)
      .where(year ? and(gte(payStubs.payDate, `${year}-01-01`), lte(payStubs.payDate, `${year}-12-31`)) : undefined)
      .orderBy(desc(payStubs.payDate), desc(payStubs.createdAt));
    if (stubs.length === 0) return [];
    const lines = await db
      .select()
      .from(payStubLines)
      .where(inArray(payStubLines.payStubId, stubs.map((s) => s.id)))
      .orderBy(asc(payStubLines.position));
    return stubs.map((s) => {
      const own = lines.filter((l) => l.payStubId === s.id);
      const totals: Record<PayLineGroup, number> = { tax: 0, insurance: 0, retirement: 0, other: 0 };
      for (const l of own) totals[groupOf(l.kind)] += l.amountCents;
      return {
        id: s.id,
        employer: s.employer,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        payDate: s.payDate,
        grossCents: s.grossCents,
        netCents: s.netCents,
        depositTransactionId: s.depositTransactionId,
        lines: own.map((l) => ({ kind: l.kind, group: groupOf(l.kind), label: l.label, amountCents: l.amountCents, categoryId: l.categoryId })),
        totals,
      };
    });
  },
});

export const payDepositCandidates = defineRead({
  name: "payStubs.depositCandidates",
  description: "Posted deposits that could be a pay stub's net pay: exactly the net amount, near the pay date, not already linked.",
  input: z.object({ payDate: z.iso.date(), netCents: z.number().int().min(1), payStubId: z.uuid().optional() }),
  run: (db, { payDate, netCents, payStubId }) => openDeposits(db, { payDate, netCents }, payStubId),
});
