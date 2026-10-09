import { and, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { categories, transactions } from "@/db/schema";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError } from "@/operations/tracked";

const isoDate = z.iso.date();

export const listTransactions = defineRead({
  name: "transactions.list",
  description:
    "List transactions, newest first. Amounts are integer cents; negative means money left the account. " +
    "Filter by date range (inclusive, YYYY-MM-DD), account, or uncategorized only.",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.uuid().optional(),
    uncategorized: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  run: (db, input) => {
    const filters: SQL[] = [];
    if (input.from) filters.push(gte(transactions.postedOn, input.from));
    if (input.to) filters.push(lte(transactions.postedOn, input.to));
    if (input.accountId) filters.push(eq(transactions.accountId, input.accountId));
    if (input.uncategorized) filters.push(isNull(transactions.categoryId));
    // Only what a model needs: no account numbers or balances exist in this
    // shape, and nothing should add them (AGENTS.md, minimal data to models).
    return db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
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
