// Client-safe labels for budget periods and schedules.

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
