import { rollUp, runningTotals, type FlowDay } from "@/lib/cashflow/series";

// The typical line on the Cash flow charts: what the three periods before
// predict for this one. Annual's months get the average of the three months
// before each (so January looks back into the year before); Monthly's days
// get the average running pace of the three months before. Averages are of
// complete, recorded periods only: a month that began before the history did
// would pull the line down, and a month still going would too. With fewer
// than three such periods there is no line, rather than one that looks
// typical and isn't. Client-safe and pure.

export const TYPICAL_PERIODS = 3;

export type TypicalSlot = { inCents: number; outCents: number } | null;

const average = (values: number[]) => Math.round(values.reduce((s, v) => s + v, 0) / values.length);

const shiftMonth = (month: string, by: number) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};

const lastDay = (start: string) => new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).getUTCDate();

/**
 * The months of `days` that can stand in a typical, by "YYYY-MM": whole, not
 * begun before history did (`firstDay`, the earliest recorded transaction),
 * and over by `today`.
 */
export function completeMonths(days: FlowDay[], { firstDay, today }: { firstDay: string; today: string }): Map<string, { inCents: number; outCents: number }> {
  const out = new Map<string, { inCents: number; outCents: number }>();
  for (const m of rollUp(days, "month")) {
    const whole = m.start.endsWith("-01") && m.days === lastDay(m.start);
    if (whole && m.start >= firstDay && m.end < today) out.set(m.start.slice(0, 7), { inCents: m.inCents, outCents: m.outCents });
  }
  return out;
}

/** The twelve months of `year`, each the average of the three months before it, or null where one of them isn't in `months`. */
export function typicalMonths(year: string, months: Map<string, { inCents: number; outCents: number }>): TypicalSlot[] {
  return Array.from({ length: 12 }, (_, i) => {
    const before = Array.from({ length: TYPICAL_PERIODS }, (_, k) => months.get(shiftMonth(`${year}-${String(i + 1).padStart(2, "0")}`, -(k + 1))));
    if (before.some((m) => !m)) return null;
    const found = before as { inCents: number; outCents: number }[];
    return { inCents: average(found.map((m) => m.inCents)), outCents: average(found.map((m) => m.outCents)) };
  });
}

/**
 * A month's days, each the average of what the three months before had
 * running in and out by that day. A shorter month holds its final total for
 * the days it doesn't have. Null unless exactly three months are given.
 */
export function typicalDays(priorMonths: FlowDay[][], length: number): TypicalSlot[] | null {
  if (priorMonths.length !== TYPICAL_PERIODS || priorMonths.some((m) => m.length === 0)) return null;
  const running = priorMonths.map(runningTotals);
  return Array.from({ length }, (_, i) => {
    const at = running.map((r) => r[Math.min(i, r.length - 1)]);
    return { inCents: average(at.map((d) => d.inCents)), outCents: average(at.map((d) => d.outCents)) };
  });
}
