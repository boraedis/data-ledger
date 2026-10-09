import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { categories, transactions } from "@/db/schema";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { merchantMemory } from "@/lib/categorize/match";
import type { Db } from "@/db/types";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError } from "@/operations/tracked";

const isoDate = z.iso.date();

export const listTransactions = defineRead({
  name: "transactions.list",
  description:
    "List transactions, newest first. Amounts are integer cents; negative means money left the account. " +
    "Filter by date range (inclusive, YYYY-MM-DD), account, or uncategorized only. " +
    "budgetOnly limits to accounts that count toward budgets (excludes investment, retirement, loan and asset accounts) — use it for anything about spending.",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.uuid().optional(),
    uncategorized: z.boolean().optional(),
    budgetOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  run: (db, input) => {
    const filters: SQL[] = [];
    if (input.from) filters.push(gte(transactions.postedOn, input.from));
    if (input.to) filters.push(lte(transactions.postedOn, input.to));
    if (input.accountId) filters.push(eq(transactions.accountId, input.accountId));
    if (input.uncategorized) filters.push(isNull(transactions.categoryId));
    if (input.budgetOnly) filters.push(inArray(transactions.accountId, budgetAccountIds(db)));
    // Only what a model needs: no account numbers or balances exist in this
    // shape, and nothing should add them (AGENTS.md, minimal data to models).
    return db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
        accountId: transactions.accountId,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(and(...filters))
      .orderBy(desc(transactions.postedOn), transactions.id)
      .limit(input.limit);
  },
});

export const setTransactionCategory = defineWrite({
  name: "transactions.setCategory",
  description: "Set the category of one transaction, or clear it with categoryId null.",
  input: z.object({ transactionId: z.uuid(), categoryId: z.uuid().nullable() }),
  apply: async (ctx, { transactionId, categoryId }) => {
    if (categoryId) {
      const [found] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
      if (!found) throw new NotFoundError(`categories ${categoryId} not found`);
    }
    return ctx.update(transactions, transactionId, { categoryId });
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
      .select({ id: transactions.id, categoryId: transactions.categoryId })
      .from(transactions)
      .where(inArray(transactions.id, ids));
    const uncategorized = new Set(current.filter((t) => t.categoryId === null).map((t) => t.id));
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
      .where(and(isNull(transactions.categoryId), inArray(transactions.accountId, budgetAccountIds(db))))
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
    .where(and(isNull(transactions.categoryId), inArray(transactions.accountId, budgetAccountIds(db))));
  return value;
}
