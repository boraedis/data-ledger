// Cash in and cash out over a period (#169), day by day, and the same days
// rolled up by week and by month, for the Cash flow tabs. Client-safe and
// pure: built once per day, so every rollup is the sum of the same days and
// a month always equals its days (and its weeks, for the days they share).

export type FlowDay = { date: string; inCents: number; outCents: number };
export type FlowTotal = { inCents: number; outCents: number; netCents: number };
export type FlowBucket = FlowTotal & { start: string; end: string; days: number };

const DAY_MS = 86_400_000;

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Every day of the period with what came in and went out on it: `ins`
 * positive (a paycheck's net, income), `outs` spending as a positive amount
 * (a refund counts against its day).
 */
export function flowDays(from: string, to: string, ins: { date: string; cents: number }[], outs: { date: string; cents: number }[]): FlowDay[] {
  const days = daysBetween(from, to).map((date) => ({ date, inCents: 0, outCents: 0 }));
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const x of ins) {
    const i = index.get(x.date);
    if (i !== undefined) days[i].inCents += x.cents;
  }
  for (const x of outs) {
    const i = index.get(x.date);
    if (i !== undefined) days[i].outCents += x.cents;
  }
  return days;
}

export function total(days: FlowDay[]): FlowTotal {
  const inCents = days.reduce((s, d) => s + d.inCents, 0);
  const outCents = days.reduce((s, d) => s + d.outCents, 0);
  return { inCents, outCents, netCents: inCents - outCents };
}

/** Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * DAY_MS).toISOString().slice(0, 10);
}

/** The days grouped by calendar month or by week (Monday first), clipped to the period. */
export function rollUp(days: FlowDay[], by: "month" | "week"): FlowBucket[] {
  const buckets = new Map<string, FlowDay[]>();
  for (const d of days) {
    const key = by === "month" ? d.date.slice(0, 7) : weekStart(d.date);
    buckets.set(key, [...(buckets.get(key) ?? []), d]);
  }
  return [...buckets.values()].map((list) => ({ start: list[0].date, end: list.at(-1)!.date, days: list.length, ...total(list) }));
}

/** Running totals: what's come in and gone out by the end of each day (#172), the last equal to the period's total. */
export function runningTotals(days: FlowDay[]): FlowDay[] {
  let inCents = 0;
  let outCents = 0;
  return days.map((d) => ({ date: d.date, inCents: (inCents += d.inCents), outCents: (outCents += d.outCents) }));
}
