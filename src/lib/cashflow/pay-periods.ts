// Cash flow by pay period (#175): how far each paycheck went. A period runs
// from a regular paycheck's pay date to the day before the next one (the
// last, to today, "so far"), so the periods cover their dates once each and
// add up to the year's cash flow for the same dates. Client-safe and pure.
//
// - Regular paychecks: stubs that aren't one-time and aren't net-only. Two
//   on the same day (two employers) are one period.
// - One-time stubs (a bonus, #113) get their own row and stay out of the
//   regular periods' pay and left over, so a bonus doesn't read as a good
//   fortnight. Their cash is still cash in for the dates they land on.
// - Net-only stubs (no deductions, gross the same as net: only the net was
//   entered) aren't treated as paychecks. They're listed as needing a gross
//   figure, and don't start a period.
// - Left over is the period's pay less its cash out. Money in other than the
//   paycheck (other income, a bonus) is shown beside it, not mixed in.
// - Targets: what the budget planned for those days, each month's targets
//   spread evenly over its days.

import type { FlowDay } from "@/lib/cashflow/series";

export type PayStubInput = { payDate: string; employer: string; netCents: number; grossCents: number; oneTime: boolean; lines: unknown[] };

export type PayPeriod = {
  start: string;
  end: string;
  inProgress: boolean;
  employers: string[];
  payCents: number;
  /** All cash in during the period, as cash flow counts it: these add up to the year's for the same dates. */
  inCents: number;
  /** Cash in during the period besides its paycheck: other income, a bonus. */
  otherInCents: number;
  outCents: number;
  leftOverCents: number;
  targetsCents: number;
};

export type OddStub = { payDate: string; employer: string; netCents: number };

const DAY_MS = 86_400_000;
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export const isNetOnly = (s: PayStubInput) => !s.oneTime && s.lines.length === 0 && s.grossCents === s.netCents;
export const isRegular = (s: PayStubInput) => !s.oneTime && !isNetOnly(s);

/** The periods starting in [from, to], newest first, with the dates they cover (oldest start to latest end). */
export function payPeriodRanges(stubs: PayStubInput[], from: string, to: string, today: string) {
  const paydays = [...new Set(stubs.filter(isRegular).map((s) => s.payDate))].filter((d) => d <= today).sort();
  const ranges = paydays
    .map((start, i) => {
      const next = paydays[i + 1];
      const end = next ? dayBefore(next) : today;
      return { start, end, inProgress: !next };
    })
    .filter((r) => r.start >= from && r.start <= to);
  return { ranges, from: ranges[0]?.start ?? null, to: ranges.at(-1)?.end ?? null };
}

/**
 * Each period's figures from the days of cash flow covering it (as
 * cashflow.series gives them) and each month's targets.
 */
export function payPeriods(input: {
  stubs: PayStubInput[];
  from: string;
  to: string;
  today: string;
  days: FlowDay[];
  monthTargets: Map<string, number>;
}): { periods: PayPeriod[]; oneTime: OddStub[]; needsGross: OddStub[] } {
  const { ranges } = payPeriodRanges(input.stubs, input.from, input.to, input.today);
  const odd = (pick: (s: PayStubInput) => boolean) =>
    input.stubs
      .filter((s) => pick(s) && s.payDate >= input.from && s.payDate <= input.to)
      .map((s) => ({ payDate: s.payDate, employer: s.employer, netCents: s.netCents }))
      .sort((a, b) => b.payDate.localeCompare(a.payDate));

  const periods = ranges.map((r) => {
    const days = input.days.filter((d) => d.date >= r.start && d.date <= r.end);
    const regular = input.stubs.filter((s) => isRegular(s) && s.payDate === r.start);
    const payCents = regular.reduce((sum, s) => sum + s.netCents, 0);
    const inCents = days.reduce((sum, d) => sum + d.inCents, 0);
    const outCents = days.reduce((sum, d) => sum + d.outCents, 0);
    const targetsCents = Math.round(days.reduce((sum, d) => sum + (input.monthTargets.get(d.date.slice(0, 7)) ?? 0) / daysIn(d.date.slice(0, 7)), 0));
    return {
      ...r,
      employers: [...new Set(regular.map((s) => s.employer))],
      payCents,
      inCents,
      // A paycheck whose deposit isn't linked or categorized yet isn't in
      // cash in, so this can't go below zero on its account.
      otherInCents: Math.max(0, inCents - payCents),
      outCents,
      leftOverCents: payCents - outCents,
      targetsCents,
    };
  });
  return { periods: periods.reverse(), oneTime: odd((s) => s.oneTime), needsGross: odd(isNetOnly) };
}
