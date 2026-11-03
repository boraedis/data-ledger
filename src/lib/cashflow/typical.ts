import { rollUp, runningTotals, type FlowDay } from "@/lib/cashflow/series";

// The typical line on the Cash flow charts: what the periods before predict
// for this one.
//   - Annual, by month: each month is the average of the same month in the
//     previous three years.
//   - Annual, by day: each day is the average running total the previous
//     three years had reached by that day.
//   - Monthly, by day: each day is the average running total the three
//     months before had by that day.
// Averages are of complete, recorded periods only: a month that began before
// the history did would pull the line down, and one still going would too.
// Annual's lines use as many of the earlier years as have the data, up to
// three, and say how many on each point; Monthly needs all three months, or
// there is no line, rather than one that looks typical and isn't.
// Client-safe and pure.

export const TYPICAL_PERIODS = 3;

/** One slot's typical, and how many earlier periods it averages. */
export type TypicalSlot = { inCents: number; outCents: number; periods: number } | null;

export type TypicalLine = { label: string; unit: "month" | "year"; slots: TypicalSlot[] };

const average = (values: number[]) => Math.round(values.reduce((s, v) => s + v, 0) / values.length);

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

/**
 * The twelve months of `year`, each the average of the same month in the
 * (up to) three years before it that `months` has, or null where none has it.
 */
export function typicalMonths(year: string, months: Map<string, { inCents: number; outCents: number }>): TypicalSlot[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, "0");
    const found = Array.from({ length: TYPICAL_PERIODS }, (_, k) => months.get(`${Number(year) - (k + 1)}-${month}`)).filter((m) => m !== undefined);
    if (found.length === 0) return null;
    return { inCents: average(found.map((m) => m.inCents)), outCents: average(found.map((m) => m.outCents)), periods: found.length };
  });
}

/**
 * A period's days, each the average of what the earlier periods given had
 * running in and out by that day. A shorter period holds its final total for
 * the days it doesn't have. Null with none given.
 */
export function typicalDays(priors: FlowDay[][], length: number): TypicalSlot[] | null {
  const running = priors.filter((p) => p.length > 0).map(runningTotals);
  if (running.length === 0) return null;
  return Array.from({ length }, (_, i) => {
    const at = running.map((r) => r[Math.min(i, r.length - 1)]);
    return { inCents: average(at.map((d) => d.inCents)), outCents: average(at.map((d) => d.outCents)), periods: running.length };
  });
}
