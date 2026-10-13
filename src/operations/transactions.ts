import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  categories,
  categorySuggestions,
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

export const listTransactions = defineRead({
  name: "transactions.list",
  description:
    "List transactions, newest first. Amounts are integer cents; negative means money left the account. " +
    "Filter by date range (inclusive, YYYY-MM-DD, on posted date), account, category (matches split parts " +
    "too), tag, text search on merchant/description, or uncategorized only. budgetOnly limits to accounts " +
    "that count toward budgets (excludes investment, retirement, loan and asset accounts) — use it for " +
    "anything about spending. Page with offset. `transfer` is set when the transaction is one side of a " +
    "transfer between the owner's accounts (never spending or income); `investmentActivity` classifies " +
    "brokerage and retirement transactions (dividend, interest, buy, sell, reinvestment, fee, transfer, other).",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    tagId: z.uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    uncategorized: z.boolean().optional(),
    budgetOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run: async (db, input) => {
    const filters: SQL[] = [];
    if (input.from) filters.push(gte(transactions.postedOn, input.from));
    if (input.to) filters.push(lte(transactions.postedOn, input.to));
    if (input.accountId) filters.push(eq(transactions.accountId, input.accountId));
    if (input.uncategorized) filters.push(isNull(transactions.categoryId), eq(transactions.isSplit, false));
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
      ...context(r.accountId, r.description, transferPairId),
      // Shared expenses (#8): what friends owe on it, and how much of an
      // incoming payment was matched to what they owed.
      sharedOwedCents: owedOff.get(r.id) ?? 0,
      reimbursedCents: matched.get(r.id) ?? 0,
      tags: tagRows.filter((t) => t.transactionId === r.id).map((t) => t.name).sort(),
    }));
  },
});

/**
 * For each transaction: the other side's account if it's a paired
 * transfer, and what kind of investment activity it is if it's in a
 * brokerage or retirement account (rule-based, src/lib/investments).
 */
async function transferAndActivity(db: Db, rows: { accountId: string; transferPairId: string | null }[]) {
  const pairIds = rows.map((r) => r.transferPairId).filter((id): id is string => Boolean(id));
  const [kinds, pairs] = await Promise.all([
    db.select({ id: accounts.id, kind: accounts.type }).from(accounts),
    pairIds.length
      ? db.select({ id: transactions.id, accountId: transactions.accountId }).from(transactions).where(inArray(transactions.id, pairIds))
      : Promise.resolve([]),
  ]);
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  const pairAccount = new Map(pairs.map((p) => [p.id, p.accountId]));
  return (
    accountId: string,
    description: string,
    transferPairId: string | null,
  ): { transfer: { transactionId: string; accountId: string } | null; investmentActivity: InvestmentActivity | null } => {
    const kind = kindOf.get(accountId);
    return {
      transfer: transferPairId ? { transactionId: transferPairId, accountId: pairAccount.get(transferPairId)! } : null,
      investmentActivity: kind && isInvestmentKind(kind) ? investmentActivity(description) : null,
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
    const context = (await transferAndActivity(db, [row]))(row.accountId, row.description, transferPairId);
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

export const spendingLines = defineRead({
  name: "transactions.spendingLines",
  description:
    "Categorized amounts for budgets and spending questions: one line per categorized transaction, and one " +
    "per part of a split transaction. Dated by experience date when set, else posted date; from/to filter " +
    "on that date (inclusive). budgetOnly (default true) limits to accounts that count toward budgets. " +
    "Net by default: what friends owe on a shared expense comes off it (your share is what counts), and the " +
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

    const [whole, split] = await Promise.all([
      db
        .select({ transactionId: transactions.id, date: effective, amountCents: transactions.amountCents, categoryId: transactions.categoryId })
        .from(transactions)
        .where(and(isNotNull(transactions.categoryId), ...filters)),
      db
        .select({ transactionId: transactions.id, date: effective, amountCents: transactionSplits.amountCents, categoryId: transactionSplits.categoryId })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
        .where(and(...filters))
        .orderBy(transactionSplits.position),
    ]);
    let lines = [...whole, ...split].map((line) => ({ ...line, categoryId: line.categoryId! }));

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

export const applyCategories = defineWrite({
  name: "transactions.applyCategories",
  description:
    "Pipeline only: categorize a batch of uncategorized transactions (one rule's, merchant memory's or the model's results).",
  // The categorization pipeline runs this once per rule (as rule:<id>), once
  // for merchant memory and once for the model's confident answers, so
  // Activity shows "Rule X categorized 23 transactions" as one undoable
  // entry rather than 23.
  allowedActors: ["rule:*", "memory", "model"],
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
    "category: from merchant memory when the merchant's history is mixed, else from the model when it had one.",
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
        return { ...row, suggestedCategoryId: verdict.categoryId, suggestionSource: "memory" as const, suggestionConfidence: null };
      }
      const model = modelByTxn.get(row.id);
      if (model?.categoryId) {
        return { ...row, suggestedCategoryId: model.categoryId, suggestionSource: "model" as const, suggestionConfidence: model.confidence };
      }
      return { ...row, suggestedCategoryId: null, suggestionSource: null, suggestionConfidence: null };
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
