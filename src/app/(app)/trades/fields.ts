import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { normalizeQuantity } from "@/lib/holdings/value";

// Shared by the Trades page's forms (#319). Client-safe.

export const SIDES = Object.keys(SIDE_LABELS) as TradeSide[];

/** Today in the browser's own time zone, as YYYY-MM-DD. */
export function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** A positive exact decimal in canonical form, or null. */
export const positive = (text: string) => {
  const n = normalizeQuantity(text);
  return n && /[1-9]/.test(n) ? n : null;
};

export const validSymbol = (text: string) => /^[A-Za-z0-9.\-]{1,16}$/.test(text.trim());

export const select = "h-8 rounded-md border bg-background px-2 text-sm";

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** When it happened: one day, or the range a draft is known to fall in. */
export function when(t: { on: string; onFrom: string | null }): string {
  return t.onFrom ? `between ${shortDay(t.onFrom)} and ${shortDay(t.on)}` : `on ${shortDay(t.on)}`;
}

/** What a draft says happened, in words: "2 more shares of ZQXV between May 3 and May 5". */
export function draftHeadline(t: { side: TradeSide; quantity: string; symbol: string | null; on: string; onFrom: string | null }): string {
  const what = t.symbol ? `of ${t.symbol}` : "of a position with no symbol";
  const change = { buy: "more", sell: "fewer", transfer_in: "moved in", transfer_out: "moved out" }[t.side];
  const shares = t.quantity === "1" ? "share" : "shares";
  const phrase = t.side === "buy" || t.side === "sell" ? `${t.quantity} ${change} ${shares} ${what}` : `${t.quantity} ${shares} ${what} ${change}`;
  return `${phrase} ${when(t)}`;
}

/** What a draft still needs before it can be confirmed, and what would help. */
export function missing(t: { symbol: string | null; onFrom: string | null; price: string | null }): { needed: string[]; optional: string[] } {
  return {
    needed: [...(t.symbol ? [] : ["the symbol"]), ...(t.onFrom ? ["the day it happened"] : [])],
    optional: t.price ? [] : ["the price (optional)"],
  };
}

export const SOURCE_LABELS = {
  hand: "Entered by hand",
  opening: "Opening position",
  position_gap: "From a change in what the brokerage reports",
} as const;
