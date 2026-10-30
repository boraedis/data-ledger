// The month's pay against its budget (#128): what came in, what the targets
// plan to spend, and what that leaves to save, planned and actual so far.
// Pure, so every figure is tested.
//
// Net pay is the month's pay stubs by pay date, every one of them (two
// paychecks in a month both count; a one-time stub too, since it's real pay
// that month). In the current month, paychecks still to come at the usual
// cadence are added at the recent pace, the same pace the tax estimate uses
// (the last three regular stubs; one-time stubs never set it), and the page
// says how many are expected rather than paid. A past month has only what
// was recorded, and none is "no pay recorded", never $0.

import { PACE_STUBS, cadenceDays } from "@/lib/taxes/estimate";

export type PayStubLike = { payDate: string; periodStart: string; periodEnd: string; netCents: number; oneTime?: boolean };

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

export type MonthPay = {
  recordedCents: number;
  recordedCount: number;
  // Paychecks still to come this month at the recent pace (current month only).
  expectedCents: number;
  expectedCount: number;
  // Null when nothing was recorded or expected: "no pay recorded".
  netPayCents: number | null;
};

export function payForMonth(month: string, today: string, stubs: PayStubLike[]): MonthPay {
  const inMonth = stubs.filter((s) => s.payDate.slice(0, 7) === month);
  const recordedCents = inMonth.reduce((sum, s) => sum + s.netCents, 0);

  let expectedCents = 0;
  let expectedCount = 0;
  const regular = stubs.filter((s) => !s.oneTime && s.payDate <= today).sort((a, b) => a.payDate.localeCompare(b.payDate));
  if (month === today.slice(0, 7) && regular.length) {
    const recent = regular.slice(-PACE_STUBS);
    const pace = Math.round(recent.reduce((sum, s) => sum + s.netCents, 0) / recent.length);
    const cadence = cadenceDays(regular.slice(-6).map((s) => ({ ...s, grossCents: 0, lines: [] })));
    // The next paychecks after the last one, while they land in this month
    // and after today (one dated today or earlier would already be a stub).
    for (let next = addDays(regular.at(-1)!.payDate, cadence); next.slice(0, 7) <= month; next = addDays(next, cadence)) {
      if (next.slice(0, 7) === month && next > today) {
        expectedCents += pace;
        expectedCount++;
      }
    }
  }
  const total = recordedCents + expectedCents;
  return { recordedCents, recordedCount: inMonth.length, expectedCents, expectedCount, netPayCents: inMonth.length || expectedCount ? total : null };
}

/**
 * Paychecks a year at a cadence (#142): weekly 52, every two weeks 26, twice
 * a month 24, monthly 12. The cadence is the usual gap between pay dates,
 * so a biweekly payer's 15-day gaps around a holiday still read as 26.
 */
export function paychecksPerYear(cadenceDays: number): number {
  return cadenceDays <= 10 ? 52 : cadenceDays <= 14 ? 26 : cadenceDays <= 17 ? 24 : 12;
}

/**
 * A typical month's net pay (#142): the year's pace divided by twelve. The
 * pace is the recent regular paycheck (the last three, as in the tax
 * estimate, so a raise shows up quickly and a bonus never sets it) times
 * paychecks a year. Every month is measured against it, so a month that
 * happens to get three biweekly paychecks doesn't look like a raise, nor a
 * two-paycheck month like a cut. Only stubs paid by `asOf` count, so a past
 * month is measured against the pay of the time. Null with no regular stubs.
 */
export function typicalMonth(stubs: PayStubLike[], asOf: string): { cents: number; paceCents: number; perYear: number } | null {
  const regular = stubs.filter((s) => !s.oneTime && s.payDate <= asOf).sort((a, b) => a.payDate.localeCompare(b.payDate));
  if (regular.length === 0) return null;
  const recent = regular.slice(-PACE_STUBS);
  const paceCents = Math.round(recent.reduce((sum, s) => sum + s.netCents, 0) / recent.length);
  const perYear = paychecksPerYear(cadenceDays(regular.slice(-6).map((s) => ({ ...s, grossCents: 0, lines: [] }))));
  return { cents: Math.round((paceCents * perYear) / 12), paceCents, perYear };
}

/** A share of net pay as a whole percent. */
const pct = (cents: number, of: number) => Math.round((cents / of) * 100);

/**
 * The strip's figures, each with its share of net pay. Saving can be
 * negative (more planned or spent than came in), and reads as such.
 */
export function paySummary({ netPayCents, targetsCents, spentCents }: { netPayCents: number; targetsCents: number; spentCents: number }) {
  const figure = (cents: number) => ({ cents, percent: netPayCents > 0 ? pct(cents, netPayCents) : null });
  return {
    netPay: figure(netPayCents),
    targets: figure(targetsCents),
    expectedSaving: figure(netPayCents - targetsCents),
    spent: figure(spentCents),
    actualSaving: figure(netPayCents - spentCents),
  };
}
