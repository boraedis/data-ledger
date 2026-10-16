import { and, desc, eq, isNotNull, max, ne } from "drizzle-orm";
import { z } from "zod";
import { categories, categorySuggestions, rules, transactions } from "@/db/schema";
import { rankChoices, type ChoiceSource } from "@/lib/categorize/choices";
import { firstMatchingRule } from "@/lib/categorize/match";
import { defineRead } from "@/operations/define";
import { NotFoundError } from "@/operations/tracked";

// The likely categories for one transaction (#34), for the quick-file
// screen a purchase notification opens. Read-only; filing goes through
// transactions.setCategory or transactions.split like everywhere else.

// How much of the merchant's history to look at, and how many recently
// used categories.
const MERCHANT_HISTORY = 20;
const RECENT = 12;

export const categoryChoices = defineRead({
  name: "transactions.categoryChoices",
  description:
    "The most likely categories for one transaction, best first, each with where the guess came from: a rule " +
    "that matches it, the owner's past categories for the same merchant, the model's suggestion, or categories " +
    "used recently. Money out is never offered an income category.",
  input: z.object({ transactionId: z.uuid() }),
  run: async (db, { transactionId }) => {
    const [txn] = await db
      .select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, description: transactions.description, merchant: transactions.merchant })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    if (!txn) throw new NotFoundError(`transactions ${transactionId} not found`);

    const filed = and(isNotNull(transactions.categoryId), ne(transactions.id, transactionId));
    const [activeRules, history, [model], recent, kinds] = await Promise.all([
      db.select().from(rules).where(eq(rules.enabled, true)).orderBy(rules.priority, rules.createdAt),
      txn.merchant
        ? db
            .select({ categoryId: transactions.categoryId })
            .from(transactions)
            .where(and(filed, eq(transactions.merchant, txn.merchant)))
            .orderBy(desc(transactions.postedOn))
            .limit(MERCHANT_HISTORY)
        : Promise.resolve([]),
      db.select({ categoryId: categorySuggestions.categoryId }).from(categorySuggestions).where(eq(categorySuggestions.transactionId, transactionId)),
      // Distinct categories by when each was last used, not the last N
      // transactions: a week of coffee would otherwise crowd out the rest.
      db
        .select({ categoryId: transactions.categoryId })
        .from(transactions)
        .where(filed)
        .groupBy(transactions.categoryId)
        .orderBy(desc(max(transactions.postedOn)))
        .limit(RECENT),
      db.select({ id: categories.id, kind: categories.kind }).from(categories),
    ]);

    const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
    // Money out is spending or a transfer; money in can be anything (a
    // refund files under the expense it refunds).
    const allowed = (id: string) => kindOf.has(id) && (txn.amountCents > 0 || kindOf.get(id) !== "income");
    const choices = rankChoices(
      {
        rule: firstMatchingRule(activeRules, txn)?.categoryId ?? null,
        memory: history.map((h) => h.categoryId!),
        model: model?.categoryId ?? null,
        recent: recent.map((r) => r.categoryId!),
      },
      allowed,
    );
    return choices as { categoryId: string; source: ChoiceSource }[];
  },
});
