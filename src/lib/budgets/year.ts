// Totals for the Year view (#124): each target's year, each month across
// targets, and the whole grid. Client-safe and pure.
//
// Only months with a target count, on both sides: a month with no target
// shows "–" in the grid and adds nothing to the year's spending or its
// target. Comparing a year's spending against a target that only covered
// part of it would read as over when it wasn't. Every cell is already a
// monthly figure (a multi-month target's even monthly share), so cells
// add up across targets as well as across months. Nothing is counted twice:
// each spending line counts toward exactly one target.

export type YearCell = { spentCents: number; targetCents: number | null };
export type YearTotal = { spentCents: number; targetCents: number; months: number };

/** The sum of the cells that had a target; null when none did. */
export function sumCells(cells: YearCell[]): YearTotal | null {
  const targeted = cells.filter((c): c is { spentCents: number; targetCents: number } => c.targetCents !== null);
  if (targeted.length === 0) return null;
  return {
    spentCents: targeted.reduce((s, c) => s + c.spentCents, 0),
    targetCents: targeted.reduce((s, c) => s + c.targetCents, 0),
    months: targeted.length,
  };
}

/** Each row's year, each month's column across rows, and the grid's total. */
export function yearTotals(rows: { months: YearCell[] }[]) {
  const columns = rows[0]?.months.length ?? 0;
  const byColumn = Array.from({ length: columns }, (_, i) => sumCells(rows.map((r) => r.months[i])));
  return {
    byRow: rows.map((r) => sumCells(r.months)),
    byColumn,
    total: sumCells(rows.flatMap((r) => r.months)),
  };
}
