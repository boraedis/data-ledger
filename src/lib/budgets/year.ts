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

// --- Periods longer than a month (#157) ---------------------------------------
//
// A quarterly or annual target is one budget for its whole period, so the
// grid shows one box per period, spanning its months, with the period's
// target and spend. Monthly targets stay one cell per month. The totals
// above don't change: they still add up monthly figures (a period's even
// monthly share), which is what lets a row's months and a month's targets
// add up at all.

type PeriodLike = { start: string; end: string; periodMonths: number; targetCents: number; spentCents: number };
type SegmentCell = { month: string; targetCents: number | null; spentCents: number; period?: PeriodLike | null };

export type Segment<C extends SegmentCell> = {
  /** Index of the segment's first month in the row. */
  first: number;
  cells: C[];
  /** The period the box stands for; null for a single month. */
  period: PeriodLike | null;
  /** The period starts before the first month shown, or ends after the last. */
  clippedBefore: boolean;
  clippedAfter: boolean;
};

const isLong = (c: SegmentCell): c is SegmentCell & { period: PeriodLike } => c.targetCents !== null && !!c.period && c.period.periodMonths > 1;

/** A row's months, with each longer period's months in one segment. */
export function gridSegments<C extends SegmentCell>(cells: C[]): Segment<C>[] {
  const segments: Segment<C>[] = [];
  cells.forEach((c, i) => {
    const last = segments.at(-1);
    if (isLong(c) && last?.period && last.period.start === c.period.start) {
      last.cells.push(c);
      return;
    }
    segments.push({ first: i, cells: [c], period: isLong(c) ? c.period : null, clippedBefore: false, clippedAfter: false });
  });
  const firstMonth = cells[0]?.month.slice(0, 7) ?? "";
  const lastMonth = cells.at(-1)?.month.slice(0, 7) ?? "";
  for (const s of segments) {
    if (!s.period) continue;
    s.clippedBefore = s.period.start.slice(0, 7) < firstMonth;
    s.clippedAfter = s.period.end.slice(0, 7) > lastMonth;
  }
  return segments;
}

/** A segment's target and spend: the period's own for a box, the month's for a cell. */
export function segmentFigures(s: Segment<SegmentCell>): { spentCents: number; targetCents: number } | null {
  if (s.period) return { spentCents: s.period.spentCents, targetCents: s.period.targetCents };
  const c = s.cells[0];
  return c.targetCents === null ? null : { spentCents: c.spentCents, targetCents: c.targetCents };
}
