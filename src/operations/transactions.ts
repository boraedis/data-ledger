import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  categories,
  categorySuggestions,
  payStubDeposits,
  payStubLines,
  payStubs,
  reimbursementMatches,
  reimbursements,
  tags,
  transactionSplits,
  transactionTags,
  transactions,
} from "@/db/schema";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { merchantMemory } from "@/lib/categorize/match";
import { isInvestmentKind, investmentActivity, type InvestmentActivity } from "@/lib/investments/activity";
import { TRANSFER_PASSES, findTransferPairs } from "@/lib/investments/transfers";
import { DAYS_AFTER as MANUAL_DAYS_AFTER, DAYS_BEFORE as MANUAL_DAYS_BEFORE } from "@/lib/manual/match";
import { expandDeposit } from "@/lib/pay/stubs";
import { distribute } from "@/lib/reimbursements/match";
import type { Db } from "@/db/types";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

const isoDate = z.iso.date();

/**
 * Transactions still waiting for a category: uncategorized, not split, in
 * an account that counts toward budgets, not one side of a transfer (#24)
 * and not a payment fully matched to reimbursements (#8) — neither needs a
 * category, it's just money moving. The one
 * definition the inbox, its badge and the pipeline all share.
 */
export function awaitingCategory(db: Db): SQL {
  return and(
    isNull(transactions.categoryId),
    eq(transactions.isSplit, false),
    isNull(transactions.transferPairId),
    inArray(transactions.accountId, budgetAccountIds(db)),
    // A payment fully matched to what friends owed (#8) is settled, not
    // income, and needs no category.
    sql`not exists (
      select 1 from ${reimbursementMatches}
      where ${reimbursementMatches.transactionId} = ${transactions.id}
      having sum(${reimbursementMatches.amountCents}) >= ${transactions.amountCents}
    )`,
  )!;
}

export type TransactionFilter = {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  tagId?: string;
  search?: string;
  uncategorized?: boolean;
  budgetOnly?: boolean;
  unmatchedTransfers?: boolean;
};

/**
 * The list's filters as SQL, shared with anything acting on "everything
 * matching this filter" (#116) so it means exactly the rows the list shows.
 */
export function transactionFilters(db: Db, input: TransactionFilter): SQL[] {
  const filters: SQL[] = [];
  if (input.from) filters.push(gte(transactions.postedOn, input.from));
  if (input.to) filters.push(lte(transactions.postedOn, input.to));
  if (input.accountId) filters.push(eq(transactions.accountId, input.accountId));
  if (input.uncategorized) filters.push(isNull(transactions.categoryId), eq(transactions.isSplit, false));
  // The same rows as the "other half not found" badge (transferUnmatched): filed
  // under a transfer category, with no pair. Cash flow's list also matches by
  // amount within days, so it can differ on a pair not yet stored (#184).
  if (input.unmatchedTransfers)
    filters.push(
      isNull(transactions.transferPairId),
      inArray(transactions.categoryId, db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer"))),
    );
  if (input.budgetOnly) filters.push(inArray(transactions.accountId, budgetAccountIds(db)));
  if (input.categoryId) {
    const viaSplit = db
      .select({ id: transactionSplits.transactionId })
      .from(transactionSplits)
      .where(eq(transactionSplits.categoryId, input.categoryId));
    filters.push(sql`(${transactions.categoryId} = ${input.categoryId} or ${transactions.id} in ${viaSplit})`);
  }
  if (input.tagId) {
    filters.push(
      inArray(
        transactions.id,
        db.select({ id: transactionTags.transactionId }).from(transactionTags).where(eq(transactionTags.tagId, input.tagId)),
      ),
    );
  }
  if (input.search) {
    // Escape LIKE wildcards so a search for "100%" means the text "100%".
    const pattern = `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(sql`(${transactions.merchant} ilike ${pattern} or ${transactions.description} ilike ${pattern})`);
  }
  return filters;
}

export const listTransactions = defineRead({
  name: "transactions.list",
  description:
    "List transactions, newest first. Amounts are integer cents; negative means money left the account. " +
    "Filter by date range (inclusive, YYYY-MM-DD, on posted date), account, category (matches split parts " +
    "too), tag, text search on merchant/description, uncategorized only, or unmatchedTransfers (transfers with no " +
    "other half). budgetOnly limits to accounts " +
    "that count toward budgets (excludes investment, retirement, loan and asset accounts) — use it for " +
    "anything about spending. Page with offset. `transfer` is set when the transaction is one side of a " +
    "transfer between the owner's accounts (never spending or income); `investmentActivity` classifies " +
    "brokerage and retirement transactions (dividend, interest, buy, sell, reinvestment, fee, transfer, other). " +
    "`transferUnmatched` is true for one filed under a transfer category whose other side wasn't found. " +
    "`payStub` is set on a paycheck deposit linked to its pay stub (pay date, employer); `paycheckWithoutStub` " +
    "is true for money in that looks like a paycheck (the category or payer of linked ones) but has none. " +
    "`provisionalSource` is set on a provisional transaction: one from a purchase alert that the bank hasn't " +
    "reported yet (see transactions.provisional). `manual` is true for one the owner added by hand.",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    tagId: z.uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    uncategorized: z.boolean().optional(),
    budgetOnly: z.boolean().optional(),
    unmatchedTransfers: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run: async (db, input) => {
    const filters = transactionFilters(db, input);
    // Only what a model needs: no account numbers or balances exist in this
    // shape, and nothing should add them (AGENTS.md, minimal data to models).
    const rows = await db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        experiencedOn: transactions.experiencedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
        pending: transactions.pending,
        provisionalSource: transactions.provisionalSource,
        manual: sql<boolean>`${transactions.source} is not distinct from 'manual'`,
        accountId: transactions.accountId,
        categoryId: transactions.categoryId,
        isSplit: transactions.isSplit,
        transferPairId: transactions.transferPairId,
      })
      .from(transactions)
      .where(and(...filters))
      .orderBy(desc(transactions.postedOn), transactions.id)
      .limit(input.limit)
      .offset(input.offset);

    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await db
          .select({ transactionId: transactionTags.transactionId, name: tags.name })
          .from(transactionTags)
          .innerJoin(tags, eq(tags.id, transactionTags.tagId))
          .where(inArray(transactionTags.transactionId, ids))
      : [];
    const [context, { owedOff, matched }] = await Promise.all([transferAndActivity(db, rows), reimbursementAdjustments(db, ids)]);
    return rows.map(({ transferPairId, ...r }) => ({
      ...r,
      ...context(r, transferPairId),
      // Shared expenses (#8): what friends owe on it, and how much of an
      // incoming payment was matched to what they owed.
      sharedOwedCents: owedOff.get(r.id) ?? 0,
      reimbursedCents: matched.get(r.id) ?? 0,
      tags: tagRows.filter((t) => t.transactionId === r.id).map((t) => t.name).sort(),
    }));
  },
});

/**
 * For each transaction, what it's connected to, so nothing is read twice:
 * - `transfer`: the other side's account, when it's a paired transfer
 * - `transferUnmatched`: filed under a transfer category, but unpaired, so
 *   its other half wasn't found (an account not connected, or not a
 *   transfer at all)
 * - `payStub`: the pay stub a paycheck deposit is linked to (#60, #91)
 * - `paycheckWithoutStub`: money in that looks like a paycheck, in the
 *   category or from the payer of the linked ones, with no stub
 * - `investmentActivity`: what a brokerage or retirement transaction is
 */
async function transferAndActivity(
  db: Db,
  rows: { id: string; accountId: string; transferPairId: string | null; description: string; amountCents: number; categoryId: string | null; merchant: string | null }[],
) {
  const ids = rows.map((r) => r.id);
  const pairIds = rows.map((r) => r.transferPairId).filter((id): id is string => Boolean(id));
  const [kinds, pairs, transferCats, stubLinks, paycheckShapes] = await Promise.all([
    db.select({ id: accounts.id, kind: accounts.type }).from(accounts),
    pairIds.length
      ? db.select({ id: transactions.id, accountId: transactions.accountId }).from(transactions).where(inArray(transactions.id, pairIds))
      : Promise.resolve([]),
    db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer")),
    ids.length
      ? db
          .select({ transactionId: payStubDeposits.transactionId, payStubId: payStubs.id, payDate: payStubs.payDate, employer: payStubs.employer })
          .from(payStubDeposits)
          .innerJoin(payStubs, eq(payStubs.id, payStubDeposits.payStubId))
          .where(inArray(payStubDeposits.transactionId, ids))
      : Promise.resolve([]),
    // What linked paychecks look like: their categories and payers.
    db
      .selectDistinct({ categoryId: transactions.categoryId, merchant: transactions.merchant })
      .from(payStubDeposits)
      .innerJoin(transactions, eq(transactions.id, payStubDeposits.transactionId)),
  ]);
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  const pairAccount = new Map(pairs.map((p) => [p.id, p.accountId]));
  const isTransferCategory = new Set(transferCats.map((c) => c.id));
  const stubOf = new Map(stubLinks.map((l) => [l.transactionId, { payStubId: l.payStubId, payDate: l.payDate, employer: l.employer }]));
  const paycheckCategories = new Set(paycheckShapes.map((p) => p.categoryId).filter(Boolean));
  const paycheckPayers = new Set(paycheckShapes.map((p) => p.merchant).filter(Boolean));
  return (
    row: { id: string; accountId: string; description: string; amountCents: number; categoryId: string | null; merchant: string | null },
    transferPairId: string | null,
  ): {
    transfer: { transactionId: string; accountId: string } | null;
    transferUnmatched: boolean;
    payStub: { payStubId: string; payDate: string; employer: string } | null;
    paycheckWithoutStub: boolean;
    investmentActivity: InvestmentActivity | null;
  } => {
    const kind = kindOf.get(row.accountId);
    const payStub = stubOf.get(row.id) ?? null;
    return {
      transfer: transferPairId ? { transactionId: transferPairId, accountId: pairAccount.get(transferPairId)! } : null,
      transferUnmatched: !transferPairId && row.categoryId !== null && isTransferCategory.has(row.categoryId),
      payStub,
      paycheckWithoutStub:
        !payStub &&
        row.amountCents > 0 &&
        ((row.categoryId !== null && paycheckCategories.has(row.categoryId)) || (row.merchant !== null && paycheckPayers.has(row.merchant))),
      investmentActivity: kind && isInvestmentKind(kind) ? investmentActivity(row.description) : null,
    };
  };
}

async function assertCategoriesExist(ctx: WriteContext, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await ctx.db.select({ id: categories.id }).from(categories).where(inArray(categories.id, unique));
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new NotFoundError(`categories ${missing.join(", ")} not found`);
}

/** Removes a transaction's split parts through tracked writes, so undo can restore them. */
export async function removeSplits(ctx: WriteContext, transactionId: string) {
  const parts = await ctx.db
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, transactionId));
  for (const part of parts) await ctx.remove(transactionSplits, part.id);
}

export const setTransactionCategory = defineWrite({
  name: "transactions.setCategory",
  description:
    "Set the category of one transaction, or clear it with categoryId null. On a split transaction this " +
    "replaces the split with the single category.",
  input: z.object({ transactionId: z.uuid(), categoryId: z.uuid().nullable() }),
  apply: async (ctx, { transactionId, categoryId }) => {
    if (categoryId) await assertCategoriesExist(ctx, [categoryId]);
    await removeSplits(ctx, transactionId);
    return ctx.update(transactions, transactionId, { categoryId, isSplit: false });
  },
});

export const setCategories = defineWrite({
  name: "transactions.setCategories",
  description:
    "Categorize a set of uncategorized transactions at once: confirming the inbox's suggestions (#86). One " +
    "entry in Activity, undone together. A transaction categorized or split since is left as it is.",
  input: z.object({
    assignments: z.array(z.object({ transactionId: z.uuid(), categoryId: z.uuid() })).min(1).max(500),
  }),
  apply: async (ctx, { assignments }) => {
    await assertCategoriesExist(ctx, [...new Set(assignments.map((a) => a.categoryId))]);
    const current = await ctx.db
      .select({ id: transactions.id, categoryId: transactions.categoryId, isSplit: transactions.isSplit })
      .from(transactions)
      .where(inArray(transactions.id, assignments.map((a) => a.transactionId)));
    const open = new Set(current.filter((t) => t.categoryId === null && !t.isSplit).map((t) => t.id));
    let applied = 0;
    for (const { transactionId, categoryId } of assignments) {
      if (!open.has(transactionId)) continue;
      open.delete(transactionId);
      await ctx.update(transactions, transactionId, { categoryId });
      applied++;
    }
    return { applied };
  },
});

export const splitTransaction = defineWrite({
  name: "transactions.split",
  description:
    "Divide a transaction into 2–20 parts, each with its own category and optional note. Parts are integer " +
    "cents with the same sign as the transaction and must add up exactly to its amount. Replaces any " +
    "existing split or category.",
  input: z.object({
    transactionId: z.uuid(),
    parts: z
      .array(
        z.object({
          amountCents: z.number().int().refine((n) => n !== 0, "A part can't be zero"),
          categoryId: z.uuid(),
          note: z.string().trim().max(120).nullable().optional(),
        }),
      )
      .min(2)
      .max(20),
  }),
  apply: async (ctx, { transactionId, parts }) => {
    const [txn] = await ctx.db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!txn) throw new NotFoundError(`transactions ${transactionId} not found`);
    // Exact integer cents: a split that's a cent off would make category
    // totals disagree with account totals forever.
    const total = parts.reduce((sum, p) => sum + p.amountCents, 0);
    if (total !== txn.amountCents) {
      throw new Error(`Parts add up to ${total} cents, but the transaction is ${txn.amountCents}`);
    }
    if (parts.some((p) => Math.sign(p.amountCents) !== Math.sign(txn.amountCents))) {
      throw new Error("Every part must have the same sign as the transaction");
    }
    await assertCategoriesExist(ctx, parts.map((p) => p.categoryId));

    await removeSplits(ctx, transactionId);
    for (const [position, part] of parts.entries()) {
      await ctx.insert(transactionSplits, {
        transactionId,
        amountCents: part.amountCents,
        categoryId: part.categoryId,
        note: part.note || null,
        position,
      });
    }
    await ctx.update(transactions, transactionId, { isSplit: true, categoryId: null });
    return { parts: parts.length };
  },
});

export const setExperienceDate = defineWrite({
  name: "transactions.setExperienceDate",
  description:
    "Set when a purchase was actually experienced, for budgeting (e.g. tickets bought months before the " +
    "event). Budgets use it instead of the posted date. Null clears it.",
  input: z.object({ transactionId: z.uuid(), experiencedOn: z.iso.date().nullable() }),
  apply: (ctx, { transactionId, experiencedOn }) => ctx.update(transactions, transactionId, { experiencedOn }),
});

export const getTransaction = defineRead({
  name: "transactions.get",
  description:
    "One transaction with its account, category or split parts, tags, experience date, transfer pairing and " +
    "investment activity (see transactions.list).",
  input: z.object({ transactionId: z.uuid() }),
  run: async (db, { transactionId }) => {
    const [row] = await db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        experiencedOn: transactions.experiencedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
        pending: transactions.pending,
        provisionalSource: transactions.provisionalSource,
        manual: sql<boolean>`${transactions.source} is not distinct from 'manual'`,
        categoryId: transactions.categoryId,
        isSplit: transactions.isSplit,
        accountId: transactions.accountId,
        accountName: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})`,
        transferPairId: transactions.transferPairId,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(eq(transactions.id, transactionId));
    if (!row) throw new NotFoundError(`transactions ${transactionId} not found`);
    const [parts, tagRows] = await Promise.all([
      db
        .select({
          id: transactionSplits.id,
          amountCents: transactionSplits.amountCents,
          categoryId: transactionSplits.categoryId,
          note: transactionSplits.note,
        })
        .from(transactionSplits)
        .where(eq(transactionSplits.transactionId, transactionId))
        .orderBy(transactionSplits.position),
      db
        .select({ id: tags.id, name: tags.name })
        .from(transactionTags)
        .innerJoin(tags, eq(tags.id, transactionTags.tagId))
        .where(eq(transactionTags.transactionId, transactionId))
        .orderBy(tags.name),
    ]);
    const { transferPairId, ...rest } = row;
    const context = (await transferAndActivity(db, [{ ...row, transferPairId }]))(row, transferPairId);
    return { ...rest, ...context, splits: parts, tags: tagRows };
  },
});

/**
 * Shared-expense adjustments for a set of transactions (#8):
 * - `owedOff`: what friends owe on a shared expense, which comes off the
 *   owner's spend — the full owed amount while it's expected, only what was
 *   actually paid once forgiven.
 * - `matched`: the part of an incoming payment matched to reimbursements,
 *   which is never income.
 */
export async function reimbursementAdjustments(db: Db, transactionIds: string[]) {
  const owedOff = new Map<string, number>();
  const matched = new Map<string, number>();
  if (transactionIds.length === 0) return { owedOff, matched };
  const [owed, paidByReimbursement, paidByPayment] = await Promise.all([
    db
      .select({ id: reimbursements.id, transactionId: reimbursements.transactionId, amountCents: reimbursements.amountCents, forgiven: reimbursements.forgiven })
      .from(reimbursements)
      .where(inArray(reimbursements.transactionId, transactionIds)),
    db
      .select({ reimbursementId: reimbursementMatches.reimbursementId, cents: sql<number>`sum(${reimbursementMatches.amountCents})`.mapWith(Number) })
      .from(reimbursementMatches)
      .innerJoin(reimbursements, eq(reimbursements.id, reimbursementMatches.reimbursementId))
      .where(inArray(reimbursements.transactionId, transactionIds))
      .groupBy(reimbursementMatches.reimbursementId),
    db
      .select({ transactionId: reimbursementMatches.transactionId, cents: sql<number>`sum(${reimbursementMatches.amountCents})`.mapWith(Number) })
      .from(reimbursementMatches)
      .where(inArray(reimbursementMatches.transactionId, transactionIds))
      .groupBy(reimbursementMatches.transactionId),
  ]);
  const paid = new Map(paidByReimbursement.map((p) => [p.reimbursementId, p.cents]));
  for (const r of owed) {
    const off = r.forgiven ? (paid.get(r.id) ?? 0) : r.amountCents;
    owedOff.set(r.transactionId, (owedOff.get(r.transactionId) ?? 0) + off);
  }
  for (const p of paidByPayment) matched.set(p.transactionId, p.cents);
  return { owedOff, matched };
}

/**
 * Whether a transaction counts as spending (#30). Everything synced does.
 * A provisional one (from a purchase alert) counts until the bank's own
 * data for its account reaches its date. From then on the bank's version,
 * if there is one, is what counts. Matching usually removes the
 * provisional row the same night. When it can't (a tip changed the
 * amount), the purchase is never counted twice while both rows exist; the
 * cost is a day or two of undercount if the bank reports other purchases
 * first.
 */
export function countsAsSpending(): SQL {
  return sql`(${transactions.provisionalSource} is null or not exists (
    select 1 from ${transactions} as synced
    where synced.account_id = ${transactions.accountId}
      and synced.provisional_source is null
      and synced.posted_on >= ${transactions.postedOn}
  )) and ${manualNotShadowed()}`;
}

/**
 * A manual transaction (#64) steps aside while the bank has one that could
 * be the same purchase (src/lib/manual/match.ts: the same account and
 * amount, close in date) and the owner hasn't decided: the bank's counts,
 * so it's never counted twice. Merging keeps the bank's; "keep both"
 * (notDuplicate) brings it back.
 */
function manualNotShadowed(): SQL {
  return sql`(${transactions.source} is distinct from 'manual' or ${transactions.notDuplicate} or not exists (
    select 1 from ${transactions} as bank
    where bank.account_id = ${transactions.accountId}
      and bank.id <> ${transactions.id}
      and bank.source is distinct from 'manual'
      and bank.provisional_source is null
      and bank.pending = false
      and bank.amount_cents = ${transactions.amountCents}
      and bank.posted_on between ${transactions.postedOn} - ${sql.raw(String(MANUAL_DAYS_BEFORE))} and ${transactions.postedOn} + ${sql.raw(String(MANUAL_DAYS_AFTER))}
  ))`;
}

type Line = { transactionId: string; date: string; amountCents: number; categoryId: string; accountId: string; merchant: string | null };

/**
 * A paycheck linked to a pay stub (#60) counts as what it was: gross pay
 * in the deposit's category, and each deduction with a category as its
 * own line (src/lib/pay/stubs.ts, expandDeposit). Pay split across
 * accounts (#91) expands onto its largest deposit, less the others, which
 * count as they are; together the parts still add up to every deposit, so
 * the net is never counted on top. Only while the links still add up to
 * the net (a deposit the bank removed leaves the rest counting as plain
 * deposits), and only a deposit counted whole: one the owner split
 * themselves keeps their split.
 */
async function withPayStubs(db: Db, lines: Line[]): Promise<Line[]> {
  const ids = [...new Set(lines.map((l) => l.transactionId))];
  if (ids.length === 0) return lines;
  const touching = db.select({ id: payStubDeposits.payStubId }).from(payStubDeposits).where(inArray(payStubDeposits.transactionId, ids));
  const links = await db
    .select({ payStubId: payStubDeposits.payStubId, transactionId: payStubDeposits.transactionId, amountCents: transactions.amountCents })
    .from(payStubDeposits)
    .innerJoin(transactions, eq(transactions.id, payStubDeposits.transactionId))
    .where(inArray(payStubDeposits.payStubId, touching));
  if (links.length === 0) return lines;
  const stubIds = [...new Set(links.map((l) => l.payStubId))];
  const [stubs, stubLines] = await Promise.all([
    db.select({ id: payStubs.id, grossCents: payStubs.grossCents, netCents: payStubs.netCents }).from(payStubs).where(inArray(payStubs.id, stubIds)),
    db
      .select({ payStubId: payStubLines.payStubId, amountCents: payStubLines.amountCents, categoryId: payStubLines.categoryId })
      .from(payStubLines)
      .where(inArray(payStubLines.payStubId, stubIds)),
  ]);

  // Per stub, its primary deposit (the largest) and what the others add up to.
  const byPrimary = new Map<string, { grossCents: number; lines: typeof stubLines }>();
  for (const stub of stubs) {
    const own = links.filter((l) => l.payStubId === stub.id).sort((a, b) => b.amountCents - a.amountCents || a.transactionId.localeCompare(b.transactionId));
    if (own.reduce((sum, l) => sum + l.amountCents, 0) !== stub.netCents) continue;
    const others = own.slice(1).reduce((sum, l) => sum + l.amountCents, 0);
    byPrimary.set(own[0].transactionId, { grossCents: stub.grossCents - others, lines: stubLines.filter((l) => l.payStubId === stub.id) });
  }
  const parts = new Map<string, number>();
  for (const l of lines) parts.set(l.transactionId, (parts.get(l.transactionId) ?? 0) + 1);
  return lines.flatMap((line) => {
    const stub = byPrimary.get(line.transactionId);
    if (!stub || parts.get(line.transactionId) !== 1) return [line];
    return expandDeposit(line, stub).map((part) => ({ ...line, ...part }));
  });
}

export const spendingLines = defineRead({
  name: "transactions.spendingLines",
  description:
    "Categorized amounts for budgets and spending questions: one line per categorized transaction, and one " +
    "per part of a split transaction. Dated by experience date when set, else posted date; from/to filter " +
    "on that date (inclusive). budgetOnly (default true) limits to accounts that count toward budgets. " +
    "A provisional transaction (from a purchase alert) counts until the bank's data for its account reaches " +
    "its date. A deposit linked to a pay stub counts as gross pay plus a line per deduction. Each line carries " +
    "its transaction's account id and merchant name, for grouping (the Spending page). Net by default: what friends owe on a shared expense comes off it (your share is what counts), and the " +
    "part of an incoming payment matched to a reimbursement is dropped (never income). gross: true returns " +
    "the amounts as charged.",
  input: z.object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    budgetOnly: z.boolean().default(true),
    gross: z.boolean().default(false),
  }),
  run: async (db, { from, to, budgetOnly, gross }) => {
    // The one definition of "what counts where" that budgets (#7) build
    // on: splits expanded into their parts, experience date winning over
    // posted date, uncategorized transactions left out, net of shared
    // expenses and reimbursements (#8).
    const effective = sql<string>`coalesce(${transactions.experiencedOn}, ${transactions.postedOn})`;
    const filters: SQL[] = [];
    if (from) filters.push(sql`${effective} >= ${from}`);
    if (to) filters.push(sql`${effective} <= ${to}`);
    if (budgetOnly) filters.push(inArray(transactions.accountId, budgetAccountIds(db)));
    filters.push(countsAsSpending());

    const [whole, split] = await Promise.all([
      db
        .select({
          transactionId: transactions.id,
          date: effective,
          amountCents: transactions.amountCents,
          categoryId: transactions.categoryId,
          accountId: transactions.accountId,
          merchant: transactions.merchant,
        })
        .from(transactions)
        .where(and(isNotNull(transactions.categoryId), ...filters)),
      db
        .select({
          transactionId: transactions.id,
          date: effective,
          amountCents: transactionSplits.amountCents,
          categoryId: transactionSplits.categoryId,
          accountId: transactions.accountId,
          merchant: transactions.merchant,
        })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
        .where(and(...filters))
        .orderBy(transactionSplits.position),
    ]);
    let lines = [...whole, ...split].map((line) => ({ ...line, categoryId: line.categoryId! }));
    lines = await withPayStubs(db, lines);

    if (!gross) {
      const { owedOff, matched } = await reimbursementAdjustments(db, [...new Set(lines.map((l) => l.transactionId))]);
      const byTxn = new Map<string, typeof lines>();
      for (const line of lines) byTxn.set(line.transactionId, [...(byTxn.get(line.transactionId) ?? []), line]);
      lines = [...byTxn.values()].flatMap((parts) => {
        const id = parts[0].transactionId;
        // An expense is negative: what friends owe moves it toward zero. A
        // payment is positive: the matched part comes off it.
        const adjust = (owedOff.get(id) ?? 0) - (matched.get(id) ?? 0);
        if (adjust === 0) return parts;
        const shares = distribute(Math.abs(adjust), parts.map((p) => p.amountCents));
        return parts
          .map((p, i) => ({ ...p, amountCents: p.amountCents + Math.sign(adjust) * shares[i] }))
          .filter((p) => p.amountCents !== 0);
      });
    }
    return lines.sort((a, b) => b.date.localeCompare(a.date));
  },
});

export const uncategorizedSpend = defineRead({
  name: "transactions.uncategorizedSpend",
  description:
    "Money out that isn't categorized yet, between two dates (inclusive, by experience date when set): how many " +
    "transactions and their total in cents (positive). It isn't in spendingLines, so the Spending page shows it " +
    "separately rather than hiding it. Budget accounts only; transfers and split transactions aren't counted.",
  input: z.object({ from: z.iso.date(), to: z.iso.date() }),
  run: async (db, { from, to }) => {
    const effective = sql<string>`coalesce(${transactions.experiencedOn}, ${transactions.postedOn})`;
    const [row] = await db
      .select({ count: count(), cents: sql<number>`coalesce(-sum(${transactions.amountCents}), 0)`.mapWith(Number) })
      .from(transactions)
      .where(
        and(
          isNull(transactions.categoryId),
          eq(transactions.isSplit, false),
          isNull(transactions.transferPairId),
          sql`${transactions.amountCents} < 0`,
          sql`${effective} >= ${from}`,
          sql`${effective} <= ${to}`,
          inArray(transactions.accountId, budgetAccountIds(db)),
          countsAsSpending(),
        ),
      );
    return { count: row.count, cents: row.cents };
  },
});

export const applyCategories = defineWrite({
  name: "transactions.applyCategories",
  description:
    "Pipeline only: categorize a batch of uncategorized transactions (one rule's matches).",
  // The categorization pipeline runs this once per rule (as rule:<id>), so
  // Activity shows "Rule X categorized 23 transactions" as one undoable
  // entry rather than 23. Rules only (#86): merchant memory and the model
  // suggest, and the owner confirms (transactions.setCategories).
  allowedActors: ["rule:*"],
  input: z.object({
    assignments: z.array(z.object({ transactionId: z.uuid(), categoryId: z.uuid() })).min(1).max(5000),
  }),
  apply: async (ctx, { assignments }) => {
    const ids = assignments.map((a) => a.transactionId);
    const current = await ctx.db
      .select({ id: transactions.id, categoryId: transactions.categoryId, isSplit: transactions.isSplit })
      .from(transactions)
      .where(inArray(transactions.id, ids));
    const uncategorized = new Set(current.filter((t) => t.categoryId === null && !t.isSplit).map((t) => t.id));
    let applied = 0;
    for (const { transactionId, categoryId } of assignments) {
      // Never overwrite: if the owner categorized it in the meantime, theirs wins.
      if (!uncategorized.has(transactionId)) continue;
      await ctx.update(transactions, transactionId, { categoryId });
      applied++;
    }
    return { applied };
  },
});

export const recordSuggestions = defineWrite({
  name: "transactions.recordSuggestions",
  description: "Pipeline only: record the model's category suggestions (or that it had none) for transactions.",
  allowedActors: ["model"],
  input: z.object({
    suggestions: z
      .array(z.object({ transactionId: z.uuid(), categoryId: z.uuid().nullable(), confidence: z.number().min(0).max(1) }))
      .min(1)
      .max(1000),
  }),
  apply: async (ctx, { suggestions }) => {
    const existing = await ctx.db
      .select({ id: categorySuggestions.id, transactionId: categorySuggestions.transactionId })
      .from(categorySuggestions)
      .where(inArray(categorySuggestions.transactionId, suggestions.map((s) => s.transactionId)));
    const byTxn = new Map(existing.map((e) => [e.transactionId, e.id]));
    for (const s of suggestions) {
      const id = byTxn.get(s.transactionId);
      if (id) await ctx.update(categorySuggestions, id, { categoryId: s.categoryId, confidence: s.confidence, createdAt: new Date() });
      else await ctx.insert(categorySuggestions, s);
    }
    return { recorded: suggestions.length };
  },
});

export const backfillMerchants = defineWrite({
  name: "transactions.backfillMerchants",
  description: "Pipeline only: derive the merchant name for transactions that don't have one yet.",
  allowedActors: ["import"],
  input: z.object({ limit: z.number().int().min(1).max(5000).default(2000) }),
  apply: async (ctx, { limit }) => {
    // Bounded per run; the nightly sync calls it until nothing's left, so
    // history from before merchants existed fills in over a night or two.
    const rows = await ctx.db
      .select({ id: transactions.id, description: transactions.description, payee: transactions.payee })
      .from(transactions)
      .where(isNull(transactions.merchant))
      .limit(limit);
    for (const row of rows) {
      await ctx.update(transactions, row.id, { merchant: normalizeMerchant(row.description, row.payee) });
    }
    return { filled: rows.length };
  },
});

export const listInbox = defineRead({
  name: "transactions.inbox",
  description:
    "Uncategorized transactions in accounts that count toward budgets, newest first, each with a suggested " +
    "category for the owner to confirm: from merchant memory when the merchant has history (suggestionAgrees: " +
    "its recent categories all agree), else from the model when it had one (with its confidence).",
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  run: async (db, { limit }) => {
    const rows = await db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
        accountId: transactions.accountId,
        pending: transactions.pending,
        provisionalSource: transactions.provisionalSource,
        manual: sql<boolean>`${transactions.source} is not distinct from 'manual'`,
      })
      .from(transactions)
      .where(
awaitingCategory(db))
      .orderBy(desc(transactions.postedOn), transactions.id)
      .limit(limit);

    const merchants = [...new Set(rows.map((r) => r.merchant).filter((m): m is string => Boolean(m)))];
    const history = merchants.length
      ? await db
          .select({ merchant: transactions.merchant, categoryId: transactions.categoryId })
          .from(transactions)
          .where(and(inArray(transactions.merchant, merchants), isNotNull(transactions.categoryId)))
          .orderBy(desc(transactions.postedOn))
      : [];
    const byMerchant = new Map<string, string[]>();
    for (const h of history) byMerchant.set(h.merchant!, [...(byMerchant.get(h.merchant!) ?? []), h.categoryId!]);

    const modelRows = rows.length
      ? await db
          .select({ transactionId: categorySuggestions.transactionId, categoryId: categorySuggestions.categoryId, confidence: categorySuggestions.confidence })
          .from(categorySuggestions)
          .where(inArray(categorySuggestions.transactionId, rows.map((r) => r.id)))
      : [];
    const modelByTxn = new Map(modelRows.map((m) => [m.transactionId, m]));

    return rows.map((row) => {
      // The owner's own history beats the model's guess.
      const verdict = row.merchant ? merchantMemory(byMerchant.get(row.merchant) ?? []) : { kind: "none" as const };
      if (verdict.kind !== "none") {
        return { ...row, suggestedCategoryId: verdict.categoryId, suggestionSource: "memory" as const, suggestionConfidence: null, suggestionAgrees: verdict.kind === "apply" };
      }
      const model = modelByTxn.get(row.id);
      if (model?.categoryId) {
        return { ...row, suggestedCategoryId: model.categoryId, suggestionSource: "model" as const, suggestionConfidence: model.confidence, suggestionAgrees: false };
      }
      return { ...row, suggestedCategoryId: null, suggestionSource: null, suggestionConfidence: null, suggestionAgrees: false };
    });
  },
});

/** The nav badge: how many transactions are waiting in the inbox. */
export async function inboxCount(db: Db): Promise<number> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(transactions)
    .where(awaitingCategory(db));
  return value;
}

// --- Transfers between the owner's own accounts (#24) -----------------------

export const matchTransfers = defineWrite({
  name: "transactions.matchTransfers",
  description:
    "Pair transactions as the two sides of a transfer between the owner's own accounts (money moved, nothing " +
    "spent or earned). Each pair needs exactly opposite amounts in two different accounts. Paired transactions " +
    "leave the inbox and never count as spending or income.",
  input: z.object({
    pairs: z.array(z.object({ cashId: z.uuid(), investmentId: z.uuid() })).min(1).max(1000),
  }),
  apply: async (ctx, { pairs }) => {
    const ids = pairs.flatMap((p) => [p.cashId, p.investmentId]);
    const rows = await ctx.db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
        provisionalSource: transactions.provisionalSource,
        transferPairId: transactions.transferPairId,
      })
      .from(transactions)
      .where(inArray(transactions.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    let matched = 0;
    for (const { cashId, investmentId } of pairs) {
      const a = byId.get(cashId);
      const b = byId.get(investmentId);
      if (!a || !b) throw new NotFoundError("Transaction not found");
      if (a.accountId === b.accountId) throw new Error("Both sides of a transfer can't be in the same account");
      if (a.amountCents !== -b.amountCents) throw new Error("A transfer's two sides must have exactly opposite amounts");
      // Pending rows can vanish when they post (import removes them), which
      // would leave the other side pointing at nothing.
      if (a.pending || b.pending) throw new Error("Pending transactions can't be paired; wait until they post");
      // Provisional rows are removed when their synced version arrives, for
      // the same reason.
      if (a.provisionalSource || b.provisionalSource) throw new Error("Provisional transactions can't be paired; wait until the bank reports them");
      // Already paired (e.g. by the owner in the meantime): leave it.
      if (a.transferPairId || b.transferPairId) continue;
      await ctx.update(transactions, a.id, { transferPairId: b.id });
      await ctx.update(transactions, b.id, { transferPairId: a.id });
      a.transferPairId = b.id;
      b.transferPairId = a.id;
      matched++;
    }
    return { matched };
  },
});

// --- Transfers filed as spending or income (#102) ---------------------------
//
// The matcher only pairs what's uncategorized or filed as a transfer: the
// owner's filing wins. So a card payment a rule filed as Shopping is never
// paired, and counts twice (the payment, and the purchases it pays for).
// This finds the pairs the matcher would have made if categories were
// ignored, for the owner to settle one way or the other. Nothing changes
// on its own: a coincidence (a $42.10 dinner and a $42.10 card refund the
// same week) looks exactly like a transfer.

export const misfiledTransfers = defineRead({
  name: "transactions.misfiledTransfers",
  description:
    "Pairs of transactions that look like a transfer between the owner's own accounts (exactly opposite amounts, " +
    "within 5 days, the only such match for each other) but where at least one side is filed under a spending or " +
    "income category, so it counts as spending or income. from/to (inclusive) keep pairs with either side dated in " +
    "range. Each pair: the side money left (out) and the side it arrived (in).",
  input: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
  run: async (db, { from, to }) => {
    const rows = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.name,
        accountType: accounts.type,
        amountCents: transactions.amountCents,
        postedOn: transactions.postedOn,
        description: transactions.description,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        categoryKind: categories.kind,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          eq(transactions.pending, false),
          isNull(transactions.provisionalSource),
          isNull(transactions.transferPairId),
          eq(transactions.transferRejected, false),
          eq(transactions.isSplit, false),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const misfiled = (r: (typeof rows)[number]) => r.categoryId !== null && r.categoryKind !== "transfer";
    const side = (r: (typeof rows)[number]) => ({
      transactionId: r.id,
      postedOn: r.postedOn,
      accountId: r.accountId,
      accountName: r.accountName,
      description: r.description,
      amountCents: r.amountCents,
      categoryName: r.categoryName,
    });
    const inRange = (on: string) => (!from || on >= from) && (!to || on <= to);

    // The matcher's passes, in its order, each over what earlier ones left.
    const taken = new Set<string>();
    const found: { out: ReturnType<typeof side>; in: ReturnType<typeof side> }[] = [];
    for (const pass of TRANSFER_PASSES) {
      const open = rows.filter((r) => !taken.has(r.id));
      const a = open.filter((r) => pass.from.includes(r.accountType));
      const b = open.filter((r) => pass.to.includes(r.accountType));
      const sources = pass.outOnly ? a.filter((r) => r.amountCents < 0) : a;
      const targets = pass.outOnly ? b.filter((r) => r.amountCents > 0) : b;
      for (const { cashId, investmentId } of findTransferPairs(sources, targets)) {
        taken.add(cashId).add(investmentId);
        const [x, y] = [byId.get(cashId)!, byId.get(investmentId)!];
        // Both uncategorized or transfers: the matcher's own job, not a misfiling.
        if (!misfiled(x) && !misfiled(y)) continue;
        if (!inRange(x.postedOn) && !inRange(y.postedOn)) continue;
        const [o, i] = x.amountCents < 0 ? [x, y] : [y, x];
        found.push({ out: side(o), in: side(i) });
      }
    }
    return found.sort((p, q) => q.out.postedOn.localeCompare(p.out.postedOn));
  },
});

export const pairAsTransfer = defineWrite({
  name: "transactions.pairAsTransfer",
  description:
    "Settle a pair from misfiledTransfers as a transfer: both sides lose their category and are paired, so " +
    "neither counts as spending or income. Undone as one.",
  input: z.object({ outId: z.uuid(), inId: z.uuid() }),
  apply: async (ctx, { outId, inId }) => {
    const rows = await ctx.db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
        provisionalSource: transactions.provisionalSource,
        transferPairId: transactions.transferPairId,
        isSplit: transactions.isSplit,
      })
      .from(transactions)
      .where(inArray(transactions.id, [outId, inId]));
    const a = rows.find((r) => r.id === outId);
    const b = rows.find((r) => r.id === inId);
    if (!a || !b) throw new NotFoundError("Transaction not found");
    if (a.accountId === b.accountId) throw new Error("Both sides of a transfer can't be in the same account");
    if (a.amountCents >= 0 || a.amountCents !== -b.amountCents) throw new Error("A transfer's two sides must have exactly opposite amounts");
    if (a.pending || b.pending || a.provisionalSource || b.provisionalSource) throw new Error("Only posted transactions can be paired");
    // A split's parts carry the categories; pairing it would leave them counting.
    if (a.isSplit || b.isSplit) throw new Error("A split transaction can't be paired; remove the split first");
    if (a.transferPairId || b.transferPairId) throw new Error("Already paired as a transfer");
    // Uncategorized, as the matcher leaves its pairs: a paired row with a
    // category would still count wherever categories are summed.
    await ctx.update(transactions, a.id, { categoryId: null, transferPairId: b.id, transferRejected: false });
    await ctx.update(transactions, b.id, { categoryId: null, transferPairId: a.id, transferRejected: false });
    return { paired: [a.id, b.id] };
  },
});

export const dismissTransfer = defineWrite({
  name: "transactions.dismissTransfer",
  description:
    "Settle a pair from misfiledTransfers as not a transfer: both keep their categories, aren't flagged again, " +
    "and the matcher won't pair either.",
  input: z.object({ transactionIds: z.array(z.uuid()).length(2) }),
  apply: async (ctx, { transactionIds }) => {
    const rows = await ctx.db.select({ id: transactions.id }).from(transactions).where(inArray(transactions.id, transactionIds));
    if (rows.length !== 2) throw new NotFoundError("Transaction not found");
    for (const { id } of rows) await ctx.update(transactions, id, { transferRejected: true });
    return { dismissed: rows.length };
  },
});

export const unmatchTransfer = defineWrite({
  name: "transactions.unmatchTransfer",
  description:
    "Mark a paired transfer as not a transfer: both sides are unpaired, return to the inbox if uncategorized, " +
    "and the matcher won't pair either again.",
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const [row] = await ctx.db
      .select({ id: transactions.id, transferPairId: transactions.transferPairId })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    if (!row) throw new NotFoundError("Transaction not found");
    if (!row.transferPairId) throw new Error("This transaction isn't paired as a transfer");
    await ctx.update(transactions, row.id, { transferPairId: null, transferRejected: true });
    await ctx.update(transactions, row.transferPairId, { transferPairId: null, transferRejected: true });
    return { unpaired: [row.id, row.transferPairId] };
  },
});
