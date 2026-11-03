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

import type { BurndownDay } from "@/lib/budgets/burndown";

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

type PeriodLike = { start: string; end: string; periodMonths: number; targetCents: number; availableCents?: number; spentCents: number };

/**
 * What a period's spending is held to: its target plus rollover and moved
 * budget, as on the target's card and the Month view (#194). Comparing the
 * grid's boxes with the bare target put their pace and their over/under a
 * little off from the card's whenever a period had anything carried in or
 * moved.
 */
export const periodBudget = (p: { targetCents: number; availableCents?: number }): number => p.availableCents ?? p.targetCents;
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
  if (s.period) return { spentCents: s.period.spentCents, targetCents: periodBudget(s.period) };
  const c = s.cells[0];
  return c.targetCents === null ? null : { spentCents: c.spentCents, targetCents: c.targetCents };
}

// --- Progress across the months (#268) ----------------------------------------
//
// The Year view's chart, to match the Month view's burndown, a point a day
// across the twelve months: what's left of the months' targets by the end of
// each day, against what the targets had used up by then (the "line": not
// straight, since a month without a target adds nothing, and each month's
// target is spread evenly over its days), and the twelve months before at
// the same point, as a share of their own targets. From the same cells as
// the totals, so the last day is the year's Under (or Over), and the days
// still to come have no "left", as on the Month view.

// dailyCents is there when the read was asked for it (budgets.monthly's `daily`).
type DayCell = YearCell & { month: string; dailyCents?: number[] };

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** What a month spent on each of its days across the rows that had a target then. */
function spentByDay(rows: { months: YearCell[] }[], i: number, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  for (const r of rows) {
    const cell = r.months[i] as DayCell | undefined;
    if (cell?.targetCents == null) continue;
    cell.dailyCents?.forEach((c, d) => (out[d] += c));
  }
  return out;
}

export function yearProgress(
  rows: { months: DayCell[] }[],
  before: { months: DayCell[] }[] | null,
  through: string,
): { days: BurndownDay[]; availableCents: number; typical: boolean } | null {
  const total = sumCells(rows.flatMap((r) => r.months));
  if (!total) return null;
  const columns = rows[0].months.length;
  // The months before: the share of their targets used by the end of each of their days.
  const prior = before ? sumCells(before.flatMap((r) => r.months)) : null;
  const priorShare: number[][] | null =
    before && prior && prior.targetCents > 0
      ? (() => {
          let used = 0;
          return Array.from({ length: columns }, (_, i) =>
            spentByDay(before, i, daysIn(before[0].months[i].month)).map((c) => (used += c) / prior.targetCents),
          );
        })()
      : null;

  let target = 0;
  let spent = 0;
  const days: BurndownDay[] = [];
  for (let i = 0; i < columns; i++) {
    const month = rows[0].months[i].month.slice(0, 7);
    const length = daysIn(month);
    const monthTarget = sumCells(rows.map((r) => r.months[i]))?.targetCents ?? 0;
    const daily = spentByDay(rows, i, length);
    for (let d = 0; d < length; d++) {
      spent += daily[d];
      const date = `${month}-${String(d + 1).padStart(2, "0")}`;
      // A shorter month before (February under a 31-day one) stands at its last day.
      const share = priorShare?.[i][Math.min(d, priorShare[i].length - 1)];
      days.push({
        date,
        leftCents: date <= through ? total.targetCents - spent : null,
        idealCents: Math.round(total.targetCents - target - (monthTarget * (d + 1)) / length),
        typicalCents: share === undefined ? null : Math.round(total.targetCents * (1 - share)),
        spentCents: daily[d],
      });
    }
    target += monthTarget;
  }
  return { days, availableCents: total.targetCents, typical: priorShare !== null };
}
