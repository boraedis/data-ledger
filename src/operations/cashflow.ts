import { z } from "zod";
import { categories } from "@/db/schema";
import { flowDays, total } from "@/lib/cashflow/series";
import { defineRead } from "@/operations/define";
import { listPayStubs } from "@/operations/pay";
import { spendingLines, uncategorizedSpend } from "@/operations/transactions";

// What came in and what went out (#169), for the Cash flow tabs: one read
// for any span, day by day, which the page rolls up by week and month
// (lib/cashflow/series.ts), so a month always equals its days.
//
// - Cash in: paychecks (the net that landed: a pay stub's linked deposits,
//   on its pay date) and income categories, in budget accounts.
// - Cash out: spending in expense categories, in budget accounts, net of
//   what friends owe and of refunds, the same lines Budgets and Spending use.
// - Left out: transfers between your own accounts, card payments matched as
//   transfers (#102; spendingLines never has a paired transfer), and
//   anything under a transfer category.
// - Not counted yet: money out with no category, reported on its own so the
//   totals don't hide it.
//
// The change in investment value isn't cash in or out, and it comes from
// balances, which stay out of operations; the page reads it from the
// net-worth library instead (lib/cashflow/investments.ts).
export const cashFlowSeries = defineRead({
  name: "cashflow.series",
  description:
    "Cash in and cash out between two dates (inclusive), day by day, and the totals, in cents. Cash in: paychecks " +
    "(a pay stub's linked net deposits, on its pay date) and income categories; cash out: spending in expense " +
    "categories, net of shared expenses and refunds unless gross. Budget accounts only. Transfers between your own " +
    "accounts, matched card payments and transfer categories are in neither. uncategorizedOut is money out not " +
    "categorized yet, left out of cash out.",
  // Pay is in it: the owner's own view, like budgets.pay.
  allowedActors: ["user"],
  input: z.object({ from: z.iso.date(), to: z.iso.date(), gross: z.boolean().default(false) }),
  run: async (db, { from, to, gross }) => {
    const [stubs, lines, cats, uncategorizedOut] = await Promise.all([
      listPayStubs.run(db, {}),
      spendingLines.run(db, { from, to, budgetOnly: true, gross }),
      db.select({ id: categories.id, kind: categories.kind }).from(categories),
      uncategorizedSpend.run(db, { from, to }),
    ]);
    const kind = new Map(cats.map((c) => [c.id, c.kind]));
    // A stub's deposits stand for its pay: never counted again as lines (in
    // spendingLines they're gross pay and a line per deduction).
    const stubDeposits = new Set(stubs.flatMap((s) => s.deposits.map((d) => d.id)));
    const pay = stubs
      .filter((s) => s.payDate >= from && s.payDate <= to && s.deposits.length)
      .map((s) => ({ date: s.payDate, cents: s.deposits.reduce((sum, d) => sum + d.amountCents, 0) }));
    const rest = lines.filter((l) => !stubDeposits.has(l.transactionId));
    const income = rest.filter((l) => kind.get(l.categoryId) === "income").map((l) => ({ date: l.date, cents: l.amountCents }));
    const spending = rest.filter((l) => kind.get(l.categoryId) === "expense").map((l) => ({ date: l.date, cents: -l.amountCents }));
    const days = flowDays(from, to, [...pay, ...income], spending);
    return { from, to, days, totals: total(days), uncategorizedOut };
  },
});
