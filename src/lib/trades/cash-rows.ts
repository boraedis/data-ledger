import { investmentActivity } from "@/lib/investments/activity";
import type { TradeSide } from "@/lib/holdings/replay";
import { isCashMove } from "@/lib/trades/cash";
import { BROKERAGE_WORDS } from "@/lib/trades/survey";

// Cash rows and drafts (#321). With positions as the record that a trade
// happened (#320), a buy or sell cash row doesn't make a draft of its own:
// it attaches to the draft it belongs to and brings what a position gap
// lacks, the day and the cash amount, and so the price.
//
// Conservative, like merchant merges: a row and a draft attach by
// themselves only when each is the other's one fit. Anything less certain
// is offered to the owner as a choice. A recognized row with no draft to fit
// is a hint on the Trades page (the share change may not have synced yet).
//
// Pure: ./cash-plan.ts loads the rows, and the trades operations write.

/** How far a cash row may settle from the trade's day, either way. */
export const SETTLEMENT_DAYS = 3;
/** How far the amount may be from quantity × that day's price: the larger of a share of it, or a commission. */
export const AMOUNT_TOLERANCE = { share: 0.02, cents: 1_000 };

export type CashRow = { id: string; accountId: string; postedOn: string; amountCents: number; text: string };
export type DraftForCash = { id: string; accountId: string; side: TradeSide; symbol: string | null; quantity: string; on: string; onFrom: string | null };
export type Recognized = CashRow & { side: "buy" | "sell"; symbol: string | null; quantity: string | null; reinvestment: boolean };

/**
 * A buy or sell row, by the existing patterns (#24), with a symbol and a
 * quantity when its text carries them. A dividend reinvestment is a buy the
 * dividend paid for (#324): it attaches to its share change the same way,
 * and makes that draft a reinvestment. The dividend itself is its own row,
 * income, and not a trade.
 */
export function recognize(row: CashRow): Recognized | null {
  // Money moving into or out of the account's own cash fund isn't a trade (#316).
  if (isCashMove(row.text)) return null;
  const kind = investmentActivity(row.text);
  if (kind !== "buy" && kind !== "sell" && kind !== "reinvestment") return null;
  // Money out is a buy, whatever the words say; a sale brings money in.
  const side = row.amountCents < 0 ? "buy" : "sell";
  if ((kind !== "sell") !== (side === "buy")) return null;
  return { ...row, side, symbol: symbolIn(row.text), quantity: quantityIn(row.text), reinvestment: kind === "reinvestment" };
}

/** The first ticker-like token that isn't a brokerage word. */
export function symbolIn(text: string): string | null {
  for (const t of text.split(/[\s/:;,()]+/)) if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(t) && !BROKERAGE_WORDS.has(t.toLowerCase())) return t;
  return null;
}

/** A quantity, when the text says one: "2.5 shares", "2.5 sh", or "2.5 @ 125.00". */
export function quantityIn(text: string): string | null {
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:shares?|sh|units?)\b/i) ?? text.match(/(\d[\d,]*(?:\.\d+)?)\s*@/);
  if (!m) return null;
  const n = m[1].replace(/,/g, "");
  return /[1-9]/.test(n) ? n.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : null;
}

const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Price per unit from a cash amount and a quantity, to four places. */
export function priceFrom(amountCents: number, quantity: string): string {
  const p = Math.abs(amountCents) / 100 / Number(quantity);
  return p.toFixed(4).replace(/\.?0+$/, "");
}

export type Fit = "amount" | "symbol";

/**
 * Whether a row could be a draft's cash, and why. Same account and side,
 * the day within the draft's range give or take settlement, and then either
 * the amount matches quantity × the day's price, or (with no price to check
 * against) the row names the draft's symbol. A price that's known and
 * doesn't match rules the row out, whatever it names.
 */
export function fit(row: Recognized, draft: DraftForCash, priceOn: (symbol: string, day: string) => number | null): Fit | null {
  if (row.accountId !== draft.accountId || row.side !== draft.side) return null;
  if (row.postedOn < shift(draft.onFrom ?? draft.on, -SETTLEMENT_DAYS) || row.postedOn > shift(draft.on, SETTLEMENT_DAYS)) return null;
  if (row.symbol && draft.symbol && row.symbol !== draft.symbol) return null;
  if (row.quantity && Number(row.quantity) !== Number(draft.quantity)) return null;
  const price = draft.symbol ? priceOn(draft.symbol, row.postedOn) : null;
  if (price !== null) {
    const expected = Number(draft.quantity) * price * 100;
    return Math.abs(Math.abs(row.amountCents) - expected) <= Math.max(expected * AMOUNT_TOLERANCE.share, AMOUNT_TOLERANCE.cents) ? "amount" : null;
  }
  return row.symbol && draft.symbol && row.symbol === draft.symbol ? "symbol" : null;
}

export type CashPlan = {
  /** Pairs that are each other's one fit: attached by the matcher. */
  attach: { tradeId: string; transactionId: string }[];
  /** For each draft, the rows it could be, when that isn't certain: the owner picks. */
  offers: Map<string, Recognized[]>;
  /** Recognized rows with no draft they could be. */
  hints: Recognized[];
};

export function planCash(rows: Recognized[], drafts: DraftForCash[], priceOn: (symbol: string, day: string) => number | null): CashPlan {
  const byDraft = new Map<string, Recognized[]>();
  const byRow = new Map<string, DraftForCash[]>();
  for (const d of drafts)
    for (const r of rows)
      if (fit(r, d, priceOn)) {
        byDraft.set(d.id, [...(byDraft.get(d.id) ?? []), r]);
        byRow.set(r.id, [...(byRow.get(r.id) ?? []), d]);
      }
  const attach: CashPlan["attach"] = [];
  const offers = new Map<string, Recognized[]>();
  for (const d of drafts) {
    const candidates = byDraft.get(d.id) ?? [];
    if (candidates.length === 1 && byRow.get(candidates[0].id)!.length === 1) attach.push({ tradeId: d.id, transactionId: candidates[0].id });
    else if (candidates.length) offers.set(d.id, candidates);
  }
  return { attach, offers, hints: rows.filter((r) => !byRow.has(r.id)) };
}
