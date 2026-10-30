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
