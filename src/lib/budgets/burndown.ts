// A budget period day by day (#149): the burndown of what's left against a
// straight line from the full amount to zero, the same days of past periods
// as a share of each one's target. (A calendar of each day's spending was
// here too, until the item page dropped it, #206.) Client-safe and pure;
// dates are YYYY-MM-DD and lines are signed like transactions (−$50 spent,
// +$10 refunded).

export type DayLine = { date: string; amountCents: number };
export type DailyPeriod = { start: string; end: string; availableCents: number; lines: DayLine[] };

const DAY_MS = 86_400_000;

/** Every day from start to end, inclusive. */
export function daysOf(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Each day's spending, positive; a refund counts against its day. */
export function dailySpent(p: DailyPeriod): number[] {
  const days = daysOf(p.start, p.end);
  const index = new Map(days.map((d, i) => [d, i]));
  const spent = new Array<number>(days.length).fill(0);
  for (const l of p.lines) {
    const i = index.get(l.date);
    if (i !== undefined) spent[i] -= l.amountCents;
  }
  return spent;
}

/** What's used of the period's budget by the end of each day, as a share of it; null without a budget. */
export function shareUsed(p: DailyPeriod): number[] | null {
  if (p.availableCents <= 0) return null;
  let total = 0;
  return dailySpent(p).map((s) => (total += s) / p.availableCents);
}

/**
 * The same days of past periods (#149's average), as the mean share used
 * by the end of each day. A shorter past period (February under a
 * 31-day month) stands at its last day for the days it doesn't have.
 */
export function averageShareUsed(past: DailyPeriod[], days: number): { share: number[]; periods: number } {
  const shares = past.map(shareUsed).filter((s): s is number[] => s !== null && s.length > 0);
  if (!shares.length) return { share: [], periods: 0 };
  const share = Array.from({ length: days }, (_, i) => shares.reduce((sum, s) => sum + s[Math.min(i, s.length - 1)], 0) / shares.length);
  return { share, periods: shares.length };
}

export type BurndownDay = {
  date: string;
  /** What's left at the end of the day; null for days still to come. */
  leftCents: number | null;
  /** The straight line from the full amount to zero at the period's end. */
  idealCents: number;
  /** What a typical past period had left by this day, in this period's money; null without one. */
  typicalCents: number | null;
  spentCents: number;
};

/** The period's burndown, through `through` (today, or the period's end). */
export function burndown(p: DailyPeriod, through: string, past: DailyPeriod[] = []): { days: BurndownDay[]; pastPeriods: number } {
  const days = daysOf(p.start, p.end);
  const spent = dailySpent(p);
  const average = averageShareUsed(past, days.length);
  let used = 0;
  return {
    pastPeriods: average.periods,
    days: days.map((date, i) => {
      used += spent[i];
      return {
        date,
        leftCents: date <= through ? p.availableCents - used : null,
        idealCents: Math.round(p.availableCents * (1 - (i + 1) / days.length)),
        typicalCents: average.periods ? Math.round(p.availableCents * (1 - average.share[i])) : null,
        spentCents: spent[i],
      };
    }),
  };
}
