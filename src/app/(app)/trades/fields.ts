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

export const KIND_LABELS = { trade: "Trade", reinvestment: "Reinvested dividend", split: "Split", transfer: "Transfer of shares", fee: "Fee paid in shares" } as const;
export type TradeKind = keyof typeof KIND_LABELS;

/** A split's ratio as people say it: 2 → "2-for-1", 0.5 → "1-for-2". */
export function ratioWords(ratio: string): string {
  const r = Number(ratio);
  // Ratios are stored to six places (0.333333 for 1-for-3), so "whole" allows for that.
  const whole = (n: number) => Math.abs(n - Math.round(n)) < 1e-4;
  if (r >= 1) return whole(r) ? `${Math.round(r)}-for-1` : whole(r * 2) ? `${Math.round(r * 2)}-for-2` : `${ratio}-for-1`;
  return whole(1 / r) ? `1-for-${Math.round(1 / r)}` : whole(2 / r) ? `2-for-${Math.round(2 / r)}` : `${ratio}-for-1`;
}

/** What a draft says happened, in words: "2 more shares of ZQXV between May 3 and May 5". */
export function draftHeadline(
  t: { side: TradeSide; quantity: string; symbol: string | null; on: string; onFrom: string | null; kind?: TradeKind; ratio?: string | null },
  otherAccount?: string,
): string {
  const what = t.symbol ? `of ${t.symbol}` : "of a position with no symbol";
  const shares = t.quantity === "1" ? "share" : "shares";
  const inward = t.side === "buy" || t.side === "transfer_in";
  switch (t.kind) {
    case "split":
      return `${t.symbol ?? "A position"} split ${t.ratio ? ratioWords(t.ratio) : ""}: ${t.quantity} ${inward ? "more" : "fewer"} ${shares} ${when(t)}`.replace("split :", "split:");
    case "reinvestment":
      return `${t.quantity} ${shares} ${what} bought with a dividend ${when(t)}`;
    case "fee":
      return `${t.quantity} ${shares} ${what} paid as a fee ${when(t)}`;
    case "transfer":
      return `${t.quantity} ${shares} ${what} moved ${inward ? "in" : "out"}${otherAccount ? ` ${inward ? "from" : "to"} ${otherAccount}` : ""} ${when(t)}`;
  }
  const change = { buy: "more", sell: "fewer", transfer_in: "moved in", transfer_out: "moved out" }[t.side];
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

/** A cash row as the Trades page shows it (#321): the owner's own description, day and amount. */
export type CashRowView = {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
  text: string;
  symbol: string | null;
  quantity: string | null;
  side: "buy" | "sell";
  // About how many shares, when the text doesn't say (#323).
  suggestedQuantity?: { value: string; basis: string };
};

/** Price per unit from a cash amount and a quantity, to four places, for filling in a form. */
export function priceText(amountCents: number, quantity: string): string {
  return (Math.abs(amountCents) / 100 / Number(quantity)).toFixed(4).replace(/\.?0+$/, "");
}
