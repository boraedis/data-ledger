// Client-safe labels for budget periods and schedules.

import { formatCents } from "@/lib/money";

const month = (date: string, withYear: boolean) =>
  new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

/** "Oct 2026", "2026", "Jul – Dec 2026", "Nov 2026 – Jan 2027". */
export function periodLabel(start: string, end: string): string {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  if (start.slice(0, 7) === end.slice(0, 7)) return month(start, true);
  if (sameYear && start.slice(5, 7) === "01" && end.slice(5, 7) === "12") return start.slice(0, 4);
  return sameYear ? `${month(start, false)} – ${month(end, true)}` : `${month(start, true)} – ${month(end, true)}`;
}

/** "monthly", "annual", "every 3 months". */
export function scheduleLabel(periodMonths: number): string {
  return periodMonths === 1 ? "monthly" : periodMonths === 12 ? "annual" : `every ${periodMonths} months`;
}

export type HistorySummary = { averageCents: number | null; months: unknown[]; overMonths: number | null; comparedMonths: number };

/**
 * "Avg $412.50/month over the last 3 months · over target in 2 of 3", or
 * "No spending in the last 3 months" (#105).
 */
export function historyLabel(h: HistorySummary | undefined, windowMonths: number): string {
  if (!h || h.averageCents === null) return `No spending in the last ${windowMonths} months`;
  const n = h.months.length;
  const avg = `Avg ${formatCents(h.averageCents)}/month over the last ${n === 1 ? "month" : `${n} months`}`;
  return h.overMonths !== null && h.comparedMonths > 0 ? `${avg} · over target in ${h.overMonths} of ${h.comparedMonths}` : avg;
}

/** History needed before a target is suggested: one month is too easy to mistake for normal. */
export const SUGGEST_MIN_MONTHS = 2;

/**
 * A starting amount for a target (#106): the monthly average times the
 * period's length, rounded to whole dollars. Null with under two months of
 * history, so a category first used last month isn't handed a target
 * built from one month. Only ever a value for the form; nothing is saved
 * until the owner saves the target.
 */
export function suggestedTargetCents(h: HistorySummary | undefined, periodMonths: number): number | null {
  if (!h || h.averageCents === null || h.months.length < SUGGEST_MIN_MONTHS) return null;
  // Rounded after scaling, so an annual suggestion isn't twelve rounding errors.
  const cents = Math.round((h.averageCents * periodMonths) / 100) * 100;
  return cents > 0 ? cents : null;
}

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The month-end projection on a card (#147): "Projected $450.00 by Sep 30,
 * $150.00 over", "On track: about $240.00 by Sep 30", or "Nothing spent
 * yet". Against what's available, so rollover and moved budget count, as
 * in the card's own "left" and "over".
 */
export function projectionLabel(t: { projectedCents: number | null; availableCents: number; end: string }): { text: string; over: boolean } {
  if (t.projectedCents === null) return { text: "Nothing spent yet", over: false };
  const by = `by ${day(t.end)}`;
  const over = t.projectedCents - t.availableCents;
  return over > 0
    ? { text: `Projected ${formatCents(t.projectedCents)} ${by}, ${formatCents(over)} over`, over: true }
    : { text: `On track: about ${formatCents(t.projectedCents)} ${by}`, over: false };
}
