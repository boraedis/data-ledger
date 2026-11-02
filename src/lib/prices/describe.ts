import type { LiveValue } from "@/lib/prices/live-value";

// How an account's value says where it's from (#230): the balance's date,
// and separately when the prices behind its positions are from, so a value
// never looks fresher than it is. Times are UTC, written as such: the server
// renders them, and doesn't know the owner's time zone.

const at = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** "Nov 2, 3:05 PM UTC" */
export const priceTime = (date: Date) => `${at.format(date)} UTC`;

/** The account line's suffix: " · prices as of …", and which positions are still at their last value. */
export function pricesNote(live: LiveValue | undefined): string {
  if (!live) return "";
  if (live.priced === 0) return " · not valued live: no current prices";
  const rest = live.unpriced.length ? ` · ${live.unpriced.join(", ")} at last value, no current price` : "";
  return ` · prices as of ${priceTime(live.pricesAsOf!)}${rest}`;
}
