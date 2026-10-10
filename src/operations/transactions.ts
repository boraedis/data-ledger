import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, tags, transactionSplits, transactionTags, transactions } from "@/db/schema";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { merchantMemory } from "@/lib/categorize/match";
import type { Db } from "@/db/types";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

const isoDate = z.iso.date();

export const listTransactions = defineRead({
  name: "transactions.list",
  description:
    "List transactions, newest first. Amounts are integer cents; negative means money left the account. " +
    "Filter by date range (inclusive, YYYY-MM-DD, on posted date), account, category (matches split parts " +
    "too), tag, text search on merchant/description, or uncategorized only. budgetOnly limits to accounts " +
    "that count toward budgets (excludes investment, retirement, loan and asset accounts) — use it for " +
    "anything about spending. Page with offset.",
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
    return rows.map((r) => ({
      ...r,
      tags: tagRows.filter((t) => t.transactionId === r.id).map((t) => t.name).sort(),
    }));
  },
});

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
  description: "One transaction with its account, category or split parts, tags and experience date.",
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
    return { ...row, splits: parts, tags: tagRows };
  },
});

export const spendingLines = defineRead({
  name: "transactions.spendingLines",
  description:
    "Categorized amounts for budgets and spending questions: one line per categorized transaction, and one " +
    "per part of a split transaction. Dated by experience date when set, else posted date; from/to filter " +
    "on that date (inclusive). budgetOnly (default true) limits to accounts that count toward budgets.",
  input: z.object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    budgetOnly: z.boolean().default(true),
  }),
  run: async (db, { from, to, budgetOnly }) => {
    // The one definition of "what counts where" that budgets (#7) build
    // on: splits expanded into their parts, experience date winning over
    // posted date, uncategorized transactions left out.
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
        .where(and(...filters)),
    ]);
    return [...whole, ...split]
      .map((line) => ({ ...line, categoryId: line.categoryId! }))
      .sort((a, b) => b.date.localeCompare(a.date));
  },
});

export const applyCategories = defineWrite({
  name: "transactions.applyCategories",
  description: "Pipeline only: categorize a batch of uncategorized transactions (one rule's or merchant memory's results).",
  // The categorization pipeline runs this once per rule (as rule:<id>) and
  // once for merchant memory, so Activity shows "Rule X categorized 23
  // transactions" as one undoable entry rather than 23.
  allowedActors: ["rule:*", "memory"],
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
    "category from merchant memory when the merchant's history is mixed.",
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
        and(isNull(transactions.categoryId), eq(transactions.isSplit, false), inArray(transactions.accountId, budgetAccountIds(db))),
      )
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

    return rows.map((row) => {
      const verdict = row.merchant ? merchantMemory(byMerchant.get(row.merchant) ?? []) : { kind: "none" as const };
      return { ...row, suggestedCategoryId: verdict.kind === "none" ? null : verdict.categoryId };
    });
  },
});

/** The nav badge: how many transactions are waiting in the inbox. */
export async function inboxCount(db: Db): Promise<number> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(transactions)
    .where(
        and(isNull(transactions.categoryId), eq(transactions.isSplit, false), inArray(transactions.accountId, budgetAccountIds(db))),
      );
  return value;
}
