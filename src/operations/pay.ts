import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, payLineKind, payStubDeposits, payStubLines, payStubs, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { DEPOSIT_DAYS_AFTER, DEPOSIT_DAYS_BEFORE, depositMatches, groupOf, stubMismatch, type PayLineGroup } from "@/lib/pay/stubs";
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
  // Omitted: link automatically if exactly one way fits (one deposit, or
  // pay split across accounts). Null: no link. Ids: those deposits, which
  // must add up to the net pay.
  depositTransactionIds: z.array(z.uuid()).min(1).max(3).nullable().optional(),
});

/**
 * The ways posted deposits near the pay date could make up the net (#91):
 * one deposit of exactly the net, or pay split across accounts. Deposits
 * already another stub's are left out.
 */
export async function openDeposits(db: Db, stub: { payDate: string; netCents: number }, exceptStubId?: string) {
  const linked = db
    .select({ id: payStubDeposits.transactionId })
    .from(payStubDeposits)
    .where(exceptStubId ? ne(payStubDeposits.payStubId, exceptStubId) : undefined);
  const rows = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents, accountId: transactions.accountId, merchant: transactions.merchant })
    .from(transactions)
    .where(
      and(
        gt(transactions.amountCents, 0),
        lte(transactions.amountCents, stub.netCents),
        eq(transactions.pending, false),
        isNull(transactions.provisionalSource),
        gte(transactions.postedOn, shift(stub.payDate, -DEPOSIT_DAYS_BEFORE)),
        lte(transactions.postedOn, shift(stub.payDate, DEPOSIT_DAYS_AFTER)),
        notInArray(transactions.id, linked),
      ),
    );
  return depositMatches(stub, rows);
}

async function checkDeposits(ctx: WriteContext, depositIds: string[], stub: { netCents: number }, exceptStubId?: string) {
  if (new Set(depositIds).size !== depositIds.length) throw new Error("The same deposit is listed twice");
  const deposits = await ctx.db.select().from(transactions).where(inArray(transactions.id, depositIds));
  if (deposits.length !== depositIds.length) throw new NotFoundError("Deposit not found");
  for (const deposit of deposits) {
    // A pending or provisional row is replaced when the bank settles it; the
    // link would quietly fall off.
    if (deposit.pending || deposit.provisionalSource) throw new Error("Link the deposit once the bank has posted it");
    if (deposit.amountCents <= 0) throw new Error("A deposit is money in");
    if (deposit.isSplit) throw new Error("That deposit is split; unsplit it first, since the pay stub says what it's made of");
  }
  const total = deposits.reduce((sum, d) => sum + d.amountCents, 0);
  if (total !== stub.netCents) {
    throw new Error(depositIds.length === 1 ? "The deposit must be exactly the net pay" : "The deposits must add up to exactly the net pay");
  }
  const [other] = await ctx.db
    .select({ id: payStubDeposits.id })
    .from(payStubDeposits)
    .where(and(inArray(payStubDeposits.transactionId, depositIds), exceptStubId ? ne(payStubDeposits.payStubId, exceptStubId) : undefined));
  if (other) throw new Error("That deposit is already another pay stub's net pay");
}

/** The deposit ids linked to each stub. */
async function linkedDeposits(db: Db, stubIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (stubIds.length === 0) return result;
  const rows = await db.select().from(payStubDeposits).where(inArray(payStubDeposits.payStubId, stubIds));
  for (const r of rows) result.set(r.payStubId, [...(result.get(r.payStubId) ?? []), r.transactionId]);
  return result;
}

/** Makes a stub's links exactly these deposits, through tracked writes. */
async function setDeposits(ctx: WriteContext, payStubId: string, depositIds: string[]) {
  const current = await ctx.db.select().from(payStubDeposits).where(eq(payStubDeposits.payStubId, payStubId));
  for (const row of current) if (!depositIds.includes(row.transactionId)) await ctx.remove(payStubDeposits, row.id);
  for (const id of depositIds) if (!current.some((r) => r.transactionId === id)) await ctx.insert(payStubDeposits, { payStubId, transactionId: id });
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

async function resolveDeposits(ctx: WriteContext, input: z.infer<typeof stubFields>, exceptStubId?: string): Promise<string[]> {
  if (input.depositTransactionIds === null) return [];
  if (input.depositTransactionIds) {
    await checkDeposits(ctx, input.depositTransactionIds, input, exceptStubId);
    return input.depositTransactionIds;
  }
  // Only an unambiguous match is linked automatically.
  const matches = await openDeposits(ctx.db, input, exceptStubId);
  return matches.length === 1 ? matches[0].map((d) => d.id) : [];
}

/** The stub's own columns from an input: everything but its lines and deposits. */
const stubColumns = (input: z.infer<typeof stubFields>) => ({
  employer: input.employer,
  periodStart: input.periodStart,
  periodEnd: input.periodEnd,
  payDate: input.payDate,
  grossCents: input.grossCents,
  netCents: input.netCents,
});

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
    "equal net exactly. The net-pay deposits are linked automatically when exactly one way fits: one deposit of the " +
    "net, or pay split across accounts (two or three deposits from the same payer adding up to it); then budgets " +
    "count gross pay and each deduction instead of the net.",
  input: stubFields,
  apply: async (ctx, input) => {
    await validate(ctx, input);
    const depositTransactionIds = await resolveDeposits(ctx, input);
    const row = await ctx.insert(payStubs, stubColumns(input));
    await writeLines(ctx, row.id, input.lines);
    await setDeposits(ctx, row.id, depositTransactionIds);
    return { payStubId: row.id, depositTransactionIds };
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
    // Omitted: keep the current links if they still add up to the (possibly
    // edited) net, else look again.
    let depositTransactionIds: string[];
    const current = (await linkedDeposits(ctx.db, [payStubId])).get(payStubId) ?? [];
    if (input.depositTransactionIds === undefined && current.length) {
      const [still] = await ctx.db
        .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`.mapWith(Number) })
        .from(transactions)
        .where(inArray(transactions.id, current));
      depositTransactionIds = still.total === input.netCents ? current : await resolveDeposits(ctx, input, payStubId);
    } else {
      depositTransactionIds = await resolveDeposits(ctx, input, payStubId);
    }
    await ctx.update(payStubs, payStubId, stubColumns(input));
    await setDeposits(ctx, payStubId, depositTransactionIds);
    const old = await ctx.db.select({ id: payStubLines.id }).from(payStubLines).where(eq(payStubLines.payStubId, payStubId));
    for (const l of old) await ctx.remove(payStubLines, l.id);
    await writeLines(ctx, payStubId, input.lines);
    return { payStubId, depositTransactionIds };
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
    await setDeposits(ctx, payStubId, []);
    await ctx.remove(payStubs, payStubId);
    return { deleted: 1 };
  },
});

export const linkPayDeposit = defineWrite({
  name: "payStubs.linkDeposit",
  description:
    "Link a pay stub to the bank deposits of its net pay: one deposit of exactly the net, or several (pay split " +
    "across accounts) adding up to it. Null unlinks.",
  input: z.object({ payStubId: z.uuid(), depositTransactionIds: z.array(z.uuid()).min(1).max(3).nullable() }),
  apply: async (ctx, { payStubId, depositTransactionIds }) => {
    const [stub] = await ctx.db.select().from(payStubs).where(eq(payStubs.id, payStubId));
    if (!stub) throw new NotFoundError("Pay stub not found");
    if (depositTransactionIds) await checkDeposits(ctx, depositTransactionIds, stub, payStubId);
    await setDeposits(ctx, payStubId, depositTransactionIds ?? []);
    return { payStubId, depositTransactionIds: depositTransactionIds ?? [] };
  },
});

export const listPayStubs = defineRead({
  name: "payStubs.list",
  description:
    "Pay stubs, newest pay date first, optionally for one calendar year: employer label, period, pay date, gross, " +
    "net, each deduction (kind, group: tax / insurance / retirement / other, label, amount, category), totals per " +
    "group, and the linked net-pay deposits if any (more than one when pay is split across accounts: each with its " +
    "date, amount and account name). Amounts are integer cents.",
  input: z.object({ year: z.number().int().min(2000).max(2100).optional() }),
  run: async (db, { year }) => {
    const stubs = await db
      .select()
      .from(payStubs)
      .where(year ? and(gte(payStubs.payDate, `${year}-01-01`), lte(payStubs.payDate, `${year}-12-31`)) : undefined)
      .orderBy(desc(payStubs.payDate), desc(payStubs.createdAt));
    if (stubs.length === 0) return [];
    const ids = stubs.map((s) => s.id);
    const [lines, deposits] = await Promise.all([
      db.select().from(payStubLines).where(inArray(payStubLines.payStubId, ids)).orderBy(asc(payStubLines.position)),
      db
        .select({
          payStubId: payStubDeposits.payStubId,
          id: transactions.id,
          postedOn: transactions.postedOn,
          amountCents: transactions.amountCents,
          accountName: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})`,
        })
        .from(payStubDeposits)
        .innerJoin(transactions, eq(transactions.id, payStubDeposits.transactionId))
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(inArray(payStubDeposits.payStubId, ids))
        .orderBy(desc(transactions.amountCents)),
    ]);
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
        deposits: deposits.filter((d) => d.payStubId === s.id).map((d) => ({ id: d.id, postedOn: d.postedOn, amountCents: d.amountCents, accountName: d.accountName })),
        lines: own.map((l) => ({ kind: l.kind, group: groupOf(l.kind), label: l.label, amountCents: l.amountCents, categoryId: l.categoryId })),
        totals,
      };
    });
  },
});

export const payDepositCandidates = defineRead({
  name: "payStubs.depositCandidates",
  description:
    "The ways posted deposits near the pay date could be a pay stub's net pay, best first: one deposit of exactly " +
    "the net, or pay split across accounts (two or three deposits from the same payer adding up to it). Not already linked.",
  input: z.object({ payDate: z.iso.date(), netCents: z.number().int().min(1), payStubId: z.uuid().optional() }),
  run: (db, { payDate, netCents, payStubId }) => openDeposits(db, { payDate, netCents }, payStubId),
});
