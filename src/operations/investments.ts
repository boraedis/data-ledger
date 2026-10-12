import { and, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { accounts, transactions } from "@/db/schema";
import { INVESTMENT_KINDS, investmentActivity, isInvestmentIncome } from "@/lib/investments/activity";
import { defineRead } from "@/operations/define";

// Investment income (#24): dividends and interest paid out in brokerage and
// retirement accounts, kept apart from paycheck income. Those accounts are
// out of budgets, so this never appears in spending or budget income; it's
// reported on its own. Transactions only (description, amount, date), the
// same data any transaction read returns — no balances or holdings.

export const investmentIncome = defineRead({
  name: "investments.income",
  description:
    "Dividends and interest earned in brokerage and retirement accounts, by month (YYYY-MM), with totals. " +
    "Separate from paycheck and other budget income. Optional from/to (YYYY-MM-DD, posted date, inclusive).",
  input: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
  run: async (db, { from, to }) => {
    const filters: SQL[] = [inArray(accounts.type, [...INVESTMENT_KINDS]), eq(transactions.pending, false)];
    if (from) filters.push(gte(transactions.postedOn, from));
    if (to) filters.push(lte(transactions.postedOn, to));
    const rows = await db
      .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents, description: transactions.description })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(...filters));

    const months = new Map<string, { month: string; dividendsCents: number; interestCents: number }>();
    let dividendsCents = 0;
    let interestCents = 0;
    for (const r of rows) {
      const activity = investmentActivity(r.description);
      if (!isInvestmentIncome(activity, r.amountCents)) continue;
      const month = r.postedOn.slice(0, 7);
      const entry = months.get(month) ?? { month, dividendsCents: 0, interestCents: 0 };
      if (activity === "dividend") {
        entry.dividendsCents += r.amountCents;
        dividendsCents += r.amountCents;
      } else {
        entry.interestCents += r.amountCents;
        interestCents += r.amountCents;
      }
      months.set(month, entry);
    }
    return {
      dividendsCents,
      interestCents,
      totalCents: dividendsCents + interestCents,
      byMonth: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    };
  },
});
