// The budgets dashboard (#146): the month and the year so far, targets
// against spend, and where the overspending is. Client-safe and pure.
//
// Built from the Year view's cells (budgets.monthly, January through the
// month shown), so the month is that column's total and the year is the
// sum of its columns: the year always equals its months added up. A
// multi-month target counts at its even monthly share, as on the Year view.
// That's why the month can differ from the Month view's total, which leaves
// multi-month targets out because their figures cover a whole period.
// Months without a target add nothing on either side (see year.ts).
//
// Budget moved between targets (budgets.rebalance) counts in the month it
// was moved, so a target's month here matches its card. Each move nets to
// zero, so totals don't change. Rollover doesn't count: carried-in money
// was already a previous month's target, and adding it again would count
// it twice in the year. A card with money carried in can show less over
// than here.

import { sumCells, type YearCell, type YearTotal } from "@/lib/budgets/year";

export type DashboardRow = { categoryId: string | null; name: string; months: (YearCell & { movedCents?: number })[] };
export type Overspend = { categoryId: string | null; name: string; spentCents: number; targetCents: number; overCents: number };

export const TOP_OVERSPENDS = 3;

function biggest(items: { categoryId: string | null; name: string; total: YearTotal | null }[]): Overspend[] {
  return items
    .flatMap(({ categoryId, name, total }) =>
      total && total.spentCents > total.targetCents
        ? [{ categoryId, name, spentCents: total.spentCents, targetCents: total.targetCents, overCents: total.spentCents - total.targetCents }]
        : [],
    )
    .sort((a, b) => b.overCents - a.overCents || a.name.localeCompare(b.name))
    .slice(0, TOP_OVERSPENDS);
}

/** `rows`' months run from January to the month shown, which is the last. */
export function budgetDashboard(input: DashboardRow[]) {
  const rows = input.map((r) => ({
    ...r,
    months: r.months.map((m) => ({ spentCents: m.spentCents, targetCents: m.targetCents === null ? null : m.targetCents + (m.movedCents ?? 0) })),
  }));
  const last = (rows[0]?.months.length ?? 0) - 1;
  const monthCells = rows.map((r) => r.months[last]).filter(Boolean);
  return {
    month: sumCells(monthCells),
    // Every cell of every row is the sum of every month's column.
    year: sumCells(rows.flatMap((r) => r.months)),
    monthOver: biggest(rows.map((r) => ({ categoryId: r.categoryId, name: r.name, total: r.months[last] ? sumCells([r.months[last]]) : null }))),
    yearOver: biggest(rows.map((r) => ({ categoryId: r.categoryId, name: r.name, total: sumCells(r.months) }))),
  };
}
