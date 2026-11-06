import { DATE_FORMATS, parseAmountCents, parseDate, type DateFormat, type RowError } from "@/lib/history/csv";
import type { TradeSide } from "@/lib/holdings/replay";
import { normalizeQuantity } from "@/lib/holdings/value";

// Reading a brokerage's CSV export (#354, epic #353), the part with no
// database: the owner's column mapping, what each of the file's actions
// means, and what each row becomes — a cash row (the money), a trade (the
// shares), or both, with a stable ID so a re-import matches. Pure and
// client-safe, tested on synthetic files only; the file is read in memory
// and never stored, as with the bank import (#35), whose reader, amounts
// and dates this reuses.
//
// No presets for particular brokerages, on purpose: a mapping the owner
// confirms works for any of them, and nothing here was written against a
// real export. Fees aren't a column: a row's amount is the cash that moved,
// net of them, which is what the account's balance saw.

// --- What an action means ---------------------------------------------------------

export const ACTION_CATEGORIES = ["buy", "sell", "reinvest", "income", "split", "shares_in", "shares_out", "fee_shares", "cash", "ignore"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

export const ACTION_LABELS: Record<ActionCategory, string> = {
  buy: "Buy",
  sell: "Sell",
  reinvest: "Reinvested dividend",
  income: "Dividend or interest (cash)",
  split: "Split",
  shares_in: "Shares moved in",
  shares_out: "Shares moved out",
  fee_shares: "Fee paid in shares",
  cash: "Other cash (deposit, withdrawal, fee)",
  ignore: "Ignore",
};

// What each category writes. A reinvestment is both: the shares bought, and
// the cash that left to buy them (the dividend is its own row, cash in).
// A split or a move of shares has no cash.
const WRITES: Record<ActionCategory, { cash: boolean; trade: boolean }> = {
  buy: { cash: true, trade: true },
  sell: { cash: true, trade: true },
  reinvest: { cash: true, trade: true },
  income: { cash: true, trade: false },
  split: { cash: false, trade: true },
  shares_in: { cash: false, trade: true },
  shares_out: { cash: false, trade: true },
  fee_shares: { cash: false, trade: true },
  cash: { cash: true, trade: false },
  ignore: { cash: false, trade: false },
};

/**
 * An action's key: upper case, without what varies row to row — anything
 * in parentheses (a symbol, "(Cash)"), digits, and runs of spaces — so
 * "YOU BOUGHT EXAMPLE FUND (ZZIX) (Cash)" and the same with another
 * quantity are one action to map.
 */
export function actionKey(text: string): string {
  return text
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\d$.,#*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A first guess at what an action means, for the owner to confirm. Null when nothing reads clearly. */
export function guessAction(key: string): ActionCategory | null {
  const k = key.toUpperCase();
  // Before dividend: "DIVIDEND REINVESTMENT" is shares bought.
  if (/REINVEST/.test(k)) return "reinvest";
  if (/SPLIT/.test(k)) return "split";
  if (/DIVIDEND|INTEREST|CAP(ITAL)? ?GAIN|DISTRIBUTION/.test(k)) return "income";
  if (/\b(BOUGHT|BUY|PURCHASE)/.test(k)) return "buy";
  if (/\b(SOLD|SELL|SALE|REDEMPTION|REDEEMED)/.test(k)) return "sell";
  if (/SHARES? (IN|RECEIVED)|RECEIVED SHARES|DELIVERED IN/.test(k)) return "shares_in";
  if (/SHARES? (OUT|DELIVERED)|DELIVERED OUT/.test(k)) return "shares_out";
  // A transfer is money unless it says shares: the owner corrects one that isn't.
  if (/DEPOSIT|WITHDRAW|CONTRIBUTION|TRANSFER|ACH|WIRE|FEE|COMMISSION|JOURNAL/.test(k)) return "cash";
  return null;
}

/**
 * The category for a row's action key: its own mapping, or the longest
 * mapped key it starts with, so the owner can map "YOU BOUGHT" once for
 * every fund. Null when it isn't mapped.
 */
export function categoryFor(key: string, actions: Record<string, ActionCategory>): ActionCategory | null {
  if (actions[key]) return actions[key];
  let best: string | null = null;
  for (const k of Object.keys(actions)) if (k && key.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? actions[best] : null;
}

// --- The mapping ------------------------------------------------------------------

export type BrokerageMapping = {
  skipRows: number;
  hasHeader: boolean;
  dateFormat: DateFormat;
  // Column indexes. Optional ones are null when the file has none.
  date: number;
  // When the cash moved, if the file says: the cash row is dated by it, so
  // it lines up with what the sync reports.
  settleDate: number | null;
  action: number;
  symbol: number;
  quantity: number;
  price: number | null;
  amount: number;
  description: number | null;
  // The file's action keys (actionKey), each to what it means.
  actions: Record<string, ActionCategory>;
};

const find = (header: string[], ...patterns: RegExp[]) => {
  for (const p of patterns) {
    const i = header.findIndex((h) => p.test(h.trim()));
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * A first guess from the header names, the first dates and the file's
 * actions, for the owner to correct. The header is the first line (of the
 * first ten) with a column named like a date, as in the bank import.
 */
export function guessBrokerageMapping(all: string[][]): BrokerageMapping {
  const found = all.slice(0, 10).findIndex((r) => r.length > 1 && r.some((c) => /date/i.test(c.trim())));
  const skipRows = Math.max(0, found);
  const rows = all.slice(skipRows);
  const header = rows[0] ?? [];
  const settle = find(header, /settle/i);
  const date = find(header, /^(trade|run|transaction|activity)? ?date$/i, /^(?!.*settle).*date/i);
  const action = find(header, /^action$/i, /^(activity|transaction)( type)?$/i, /^type$/i, /action|activity/i);
  const symbol = find(header, /^symbol$/i, /symbol|ticker/i);
  const quantity = find(header, /^quantity$/i, /quantity|shares|qty|units/i);
  const price = find(header, /^price/i, /price/i);
  const amount = find(header, /^amount/i, /^net amount|^total/i, /amount/i);
  const description = find(header, /^description$/i, /security|description|name|memo|note/i);
  const sample = rows.slice(1, 20).map((r) => r[Math.max(0, date)] ?? "");
  const dateFormat = DATE_FORMATS.find((f) => sample.length > 0 && sample.every((s) => parseDate(s, f))) ?? "MM/DD/YYYY";
  const mapping: BrokerageMapping = {
    skipRows,
    hasHeader: true,
    dateFormat,
    date: Math.max(0, date),
    settleDate: settle >= 0 && settle !== date ? settle : null,
    action: Math.max(0, action),
    symbol: Math.max(0, symbol),
    quantity: Math.max(0, quantity),
    price: price >= 0 ? price : null,
    amount: Math.max(0, amount),
    description: description >= 0 && description !== action ? description : null,
    actions: {},
  };
  for (const key of distinctActions(all, mapping)) {
    const guess = guessAction(key);
    if (guess) mapping.actions[key] = guess;
  }
  return mapping;
}

const dataRows = (all: string[][], m: Pick<BrokerageMapping, "skipRows" | "hasHeader">) => {
  const start = m.skipRows + (m.hasHeader ? 1 : 0);
  return all.slice(start).map((cells, i) => ({ cells, row: start + i + 1 }));
};

/** Each action key in the file once, most frequent first, for the owner to map. */
export function distinctActions(all: string[][], mapping: Pick<BrokerageMapping, "skipRows" | "hasHeader" | "action">): string[] {
  const counts = new Map<string, number>();
  for (const { cells } of dataRows(all, mapping)) {
    const key = actionKey(cells[mapping.action] ?? "");
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

// --- Rows -------------------------------------------------------------------------

export type ImportedCash = { postedOn: string; amountCents: number; description: string };
export type ImportedTrade = {
  on: string;
  kind: "trade" | "reinvestment" | "split" | "transfer" | "fee";
  side: TradeSide;
  symbol: string;
  // Positive; the side says which way.
  quantity: string;
  price: string | null;
};
export type BrokerageRow = {
  // As numbered in the file, from 1.
  row: number;
  // Stable across imports of the same file: the cash row's external ID and the trade's import key.
  id: string;
  action: string;
  category: Exclude<ActionCategory, "ignore">;
  cash: ImportedCash | null;
  trade: ImportedTrade | null;
};

/** A signed decimal from a quantity or price cell: "1,234.5", "-3", "(2.5)", "$101.25". Null for blank or anything else. */
export function parseSignedDecimal(text: string): { value: string; negative: boolean } | null {
  let t = text.trim().replace(/[$\s]/g, "");
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const value = normalizeQuantity(t);
  return value === null ? null : { value, negative };
}

// Price per unit from the cash and the quantity when the file has no price,
// to four places, as the Trades page fills it in (#321).
const priceFrom = (amountCents: number, quantity: string) => (Math.abs(amountCents) / 100 / Number(quantity)).toFixed(4).replace(/\.?0+$/, "");

// FNV-1a, 32-bit, as in the bank import: "the same text gives the same ID".
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const TRADE_SHAPE: Record<"buy" | "sell" | "reinvest" | "shares_in" | "shares_out" | "fee_shares", Pick<ImportedTrade, "kind" | "side">> = {
  buy: { kind: "trade", side: "buy" },
  sell: { kind: "trade", side: "sell" },
  reinvest: { kind: "reinvestment", side: "buy" },
  shares_in: { kind: "transfer", side: "transfer_in" },
  shares_out: { kind: "transfer", side: "transfer_out" },
  fee_shares: { kind: "fee", side: "sell" },
};

/**
 * The file's rows under a mapping, and the rows it couldn't read. Ignored
 * actions are left out without an error. A row's ID is built from its day,
 * action, symbol, quantity and amount, and how many identical rows came
 * before it, so the same file twice matches every row and two identical
 * buys on one day stay two.
 */
export function applyBrokerageMapping(all: string[][], mapping: BrokerageMapping): { rows: BrokerageRow[]; errors: RowError[] } {
  const rows: BrokerageRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  for (const { cells, row } of dataRows(all, mapping)) {
    const cell = (i: number | null) => (i === null ? "" : (cells[i] ?? "").trim());
    const actionText = cell(mapping.action).replace(/\s+/g, " ");
    const key = actionKey(actionText);
    if (!key) {
      errors.push({ row, message: "No action" });
      continue;
    }
    const category = categoryFor(key, mapping.actions);
    if (!category) {
      errors.push({ row, message: `"${key}" isn't mapped to an action yet` });
      continue;
    }
    if (category === "ignore") continue;
    const on = parseDate(cell(mapping.date), mapping.dateFormat);
    if (!on) {
      errors.push({ row, message: `Date "${cell(mapping.date)}" isn't ${mapping.dateFormat}` });
      continue;
    }
    const settled = mapping.settleDate === null ? null : parseDate(cell(mapping.settleDate), mapping.dateFormat);
    const writes = WRITES[category];
    const rawSymbol = cell(mapping.symbol).toUpperCase();
    const symbol = /^[A-Z0-9.\-]{1,16}$/.test(rawSymbol) ? rawSymbol : null;
    const amountCents = parseAmountCents(cell(mapping.amount));
    const qty = parseSignedDecimal(cell(mapping.quantity));

    let trade: ImportedTrade | null = null;
    if (writes.trade) {
      if (!symbol) {
        errors.push({ row, message: `${ACTION_LABELS[category]} with no symbol` });
        continue;
      }
      if (!qty || qty.value === "0") {
        errors.push({ row, message: `${ACTION_LABELS[category]} of ${symbol} with no quantity` });
        continue;
      }
      // A split's quantity is the change in shares: its sign is the way.
      const shape = category === "split" ? { kind: "split" as const, side: qty.negative ? ("sell" as const) : ("buy" as const) } : TRADE_SHAPE[category as keyof typeof TRADE_SHAPE];
      const priced = mapping.price === null ? null : parseSignedDecimal(cell(mapping.price));
      const price =
        category === "split" || shape.kind === "transfer"
          ? null
          : priced && priced.value !== "0"
            ? priced.value
            : amountCents
              ? priceFrom(amountCents, qty.value)
              : null;
      trade = { on, ...shape, symbol, quantity: qty.value, price };
    }

    let cash: ImportedCash | null = null;
    // A buy or sell with no cash in the file (an amount column left blank)
    // is still its trade; a cash-only row with none is nothing, so an error.
    if (writes.cash && amountCents) {
      const description = cell(mapping.description).replace(/\s+/g, " ");
      cash = { postedOn: settled ?? on, amountCents, description: [actionText, description && description !== actionText ? description : symbol].filter(Boolean).join(" ").slice(0, 500) };
    } else if (writes.cash && !writes.trade) {
      errors.push({ row, message: amountCents === 0 ? "Amount is zero" : "No amount" });
      continue;
    }

    const idKey = `${on}|${key}|${symbol ?? ""}|${qty ? `${qty.negative ? "-" : ""}${qty.value}` : ""}|${amountCents ?? ""}`;
    const n = seen.get(idKey) ?? 0;
    seen.set(idKey, n + 1);
    rows.push({ row, id: `brk:${on}:${fingerprint(idKey)}:${n}`, action: actionText, category, cash, trade });
  }
  return { rows, errors };
}
