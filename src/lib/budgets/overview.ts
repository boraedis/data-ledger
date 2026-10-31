// The budgets page's overview (#122): one row per target in effect, with the
// same figures as its card, and a total. Client-safe and pure.
//
// The total adds up the targets measured on this month alone. An annual or
// other multi-month target's figures are for its whole period (a year's
// budget, spending since January), so adding them to a month's would give a
// number that means nothing; those rows are listed under the total with
// their own period instead. Nothing is counted twice: each spending line
// counts toward exactly one target (its category's, its parent's, or the
// buffer's), so the rows can simply be added.

import { monthIndex } from "@/lib/budgets/engine";

export type OverviewTarget = {
  categoryId: string | null;
  name: string;
  start: string;
  end: string;
  spentCents: number;
  availableCents: number;
  remainingCents: number;
  // Share of the period elapsed (#159), for the pace colours.
  elapsedShare: number;
};

export type OverviewRow = OverviewTarget & { anchor: string };

/** The id of a target's card on the page, which overview rows link to. */
export const targetAnchor = (categoryId: string | null) => `target-${categoryId ?? "buffer"}`;

const isOneMonth = (t: OverviewTarget) => monthIndex(t.end) === monthIndex(t.start);

export function budgetOverview(targets: OverviewTarget[]) {
  const row = (t: OverviewTarget): OverviewRow => ({ ...t, anchor: targetAnchor(t.categoryId) });
  const monthly = targets.filter(isOneMonth).map(row);
  const longer = targets.filter((t) => !isOneMonth(t)).map(row);
  const sum = (pick: (r: OverviewRow) => number) => monthly.reduce((s, r) => s + pick(r), 0);
  return {
    monthly,
    longer,
    total: monthly.length
      ? { spentCents: sum((r) => r.spentCents), availableCents: sum((r) => r.availableCents), remainingCents: sum((r) => r.remainingCents) }
      : null,
  };
}
