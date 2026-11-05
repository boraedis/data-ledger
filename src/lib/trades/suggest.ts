import type { TradeSide } from "@/lib/holdings/replay";

// Suggesting what a draft trade lacks (#323), from what's already known:
// arithmetic on the snapshots, the cash row and the price cache, never a
// model. A suggestion is shown with its basis and saved only when the owner
// accepts it.
//
// Sources, in this order, because the earlier ones are what the owner
// actually paid rather than what the market did that day:
//   1. The snapshots: change in cost basis ÷ change in shares is the price
//      paid on a buy, where the brokerage reports cost basis (#316).
//   2. The cash row (#321): amount ÷ quantity.
//   3. The price cache (#229): the day's close; or, for a fund with no
//      quote, market value ÷ shares on the snapshot day.
//
// Pure: ./suggest-load.ts gathers the facts for each draft.

export type Suggestion = { field: "price" | "on" | "symbol" | "quantity"; value: string; basis: string };

export type PositionDay = { on: string; shares: string; marketValueCents: number; costBasisCents: number | null };
export type Close = { on: string; price: number };

export type DraftFacts = {
  side: TradeSide;
  quantity: string;
  symbol: string | null;
  on: string;
  onFrom: string | null;
  price: string | null;
  /** The position just before the draft's range, and at its end (null when it didn't exist then). */
  before: PositionDay | null;
  after: PositionDay | null;
  /** The attached cash row's amount, when there is one. */
  cashCents: number | null;
  /** Closing prices for the draft's symbol over its range and a few days before. */
  closes: Close[];
  /** Symbols named by buy or sell cash rows in the account around the range, with the day. */
  namedSymbols: { symbol: string; on: string }[];
};

const fixed = (n: number) => n.toFixed(4).replace(/\.?0+$/, "");
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** A commission is a few dollars either way; more than this and it's a different price. */
const COMMISSION_CENTS = 2_500;

/** The close for a day, or the latest before it within the facts. */
function closeOn(closes: Close[], day: string): Close | null {
  return closes.filter((c) => c.on <= day).sort((a, b) => b.on.localeCompare(a.on))[0] ?? null;
}

export function suggest(f: DraftFacts): { suggestions: Suggestion[]; notes: string[] } {
  const suggestions: Suggestion[] = [];
  const notes: string[] = [];
  const quantity = Number(f.quantity);
  const buying = f.side === "buy" || f.side === "transfer_in";

  // Price.
  if (!f.price) {
    const fromBasis =
      buying && f.after?.costBasisCents != null && (f.before === null || f.before.costBasisCents !== null)
        ? (f.after.costBasisCents - (f.before?.costBasisCents ?? 0)) / 100 / (Number(f.after.shares) - Number(f.before?.shares ?? 0))
        : null;
    if (fromBasis && fromBasis > 0 && Number.isFinite(fromBasis)) suggestions.push({ field: "price", value: fixed(fromBasis), basis: `about ${dollars(fromBasis)}, from the change in cost basis` });
    if (f.cashCents !== null && quantity > 0) {
      const fromCash = Math.abs(f.cashCents) / 100 / quantity;
      suggestions.push({ field: "price", value: fixed(fromCash), basis: `about ${dollars(fromCash)}, the cash row's amount over ${f.quantity} shares` });
    }
    const close = closeOn(f.closes, f.on);
    if (close) suggestions.push({ field: "price", value: fixed(close.price), basis: `${dollars(close.price)}, the closing price on ${shortDay(close.on)}` });
    else if (f.after && Number(f.after.shares) > 0 && f.after.marketValueCents > 0) {
      const fromValue = f.after.marketValueCents / 100 / Number(f.after.shares);
      suggestions.push({ field: "price", value: fixed(fromValue), basis: `about ${dollars(fromValue)}, the position's value over its shares on ${shortDay(f.after.on)}` });
    }
    if (!suggestions.some((s) => s.field === "price")) notes.push("No price for these days yet, and no cost basis or cash row to work one out from.");
  }

  // A cash row and the market disagreeing by about a commission: say so, pick neither.
  if (f.cashCents !== null) {
    const close = closeOn(f.closes, f.on);
    if (close) {
      const gap = Math.abs(f.cashCents) - quantity * close.price * 100;
      if (Math.abs(gap) >= 100 && Math.abs(gap) <= COMMISSION_CENTS)
        notes.push(`The cash row is ${dollars(Math.abs(gap) / 100)} ${gap > 0 ? "more" : "less"} than ${f.quantity} × the close: maybe a commission or fee.`);
    }
  }

  // The day: within the range, the one whose close is nearest the price (known, or the first suggested).
  if (f.onFrom) {
    const target = f.price ? Number(f.price) : Number(suggestions.find((s) => s.field === "price" && !s.basis.includes("closing price"))?.value ?? NaN);
    const inRange = f.closes.filter((c) => c.on >= f.onFrom! && c.on <= f.on);
    if (Number.isFinite(target) && inRange.length) {
      const best = [...inRange].sort((a, b) => Math.abs(a.price - target) - Math.abs(b.price - target) || a.on.localeCompare(b.on))[0];
      suggestions.push({ field: "on", value: best.on, basis: `${shortDay(best.on)}, when it closed at ${dollars(best.price)}, nearest ${dollars(target)}` });
    }
  }

  // The symbol: what the cash rows around it name.
  if (!f.symbol) {
    for (const s of [...new Map(f.namedSymbols.map((n) => [n.symbol, n])).values()])
      suggestions.push({ field: "symbol", value: s.symbol, basis: `${s.symbol}, named by a cash row on ${shortDay(s.on)}` });
  }
  return { suggestions, notes };
}

/** How many shares a cash amount buys at a day's close, for a cash row with no quantity in its text. */
export function quantityFor(amountCents: number, close: Close | null): Suggestion | null {
  if (!close || close.price <= 0) return null;
  const q = Math.abs(amountCents) / 100 / close.price;
  return { field: "quantity", value: fixed(q), basis: `about ${fixed(q)} shares, at the ${dollars(close.price)} close on ${shortDay(close.on)}` };
}
