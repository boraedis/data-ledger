// Pace math shared by budgets' sinking funds (#7) and savings goals (#10):
// how far through a span we are, where an even pace would have you by now,
// and what it takes per month to finish on time. Dates are YYYY-MM-DD.

const DAY_MS = 86_400_000;

/** Days from `start` to `end`, inclusive. */
export function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
}

/** Share of [start, end] elapsed on `on`, counting `on` itself; clamped to 0–1. */
export function elapsedShare(start: string, end: string, on: string): number {
  if (on < start) return 0;
  return Math.min(1, daysInclusive(start, on) / daysInclusive(start, end));
}

/** Where an even pace from `from` to `to` (cents) stands at `share` of the way. */
export function evenPace(fromCents: number, toCents: number, share: number): number {
  return Math.round(fromCents + (toCents - fromCents) * share);
}

/**
 * Where spending ends up at the end of a span if it carries on as it has
 * (#147): spent so far over the share elapsed, a straight line. Null with
 * nothing spent yet (or a net refund): there's no pace to carry on at, and
 * $0 would read as a prediction.
 */
export function projectAtEnd(spentCents: number, share: number): number | null {
  if (spentCents <= 0 || share <= 0) return null;
  return Math.round(spentCents / share);
}

/** Calendar months from `on` until `end`, counting the current one: Oct 13 → Dec 31 is 3. */
export function monthsLeft(on: string, end: string): number {
  if (end < on) return 0;
  const index = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  return index(end) - index(on) + 1;
}

/** Per month needed to close `remainingCents` by `end`, spread over the months left; null once the date has passed. */
export function monthlyNeeded(remainingCents: number, on: string, end: string): number | null {
  const months = monthsLeft(on, end);
  if (months === 0) return null;
  return Math.max(0, Math.ceil(remainingCents / months));
}
