import { and, eq, inArray } from "drizzle-orm";
import { accounts, dailyPrices, manualPositions, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { positionValueCents } from "@/lib/holdings/value";
import { holdingsOn, inOrder, type Trade } from "@/lib/holdings/replay";
import type { AssetClass } from "@/lib/prices/source";

// History rebuilt from trades (#232): what each account's positions were
// worth on each past day, as the quantity held that day (replaying its
// trades, #247) times that day's closing price (backfilled, ./backfill.ts).
//
// Nothing is guessed. A day counts for an account only if every symbol it
// held then has a known price: that day's close, or the last one before it
// within MAX_CARRY_DAYS (a weekend or a holiday has no close of its own).
// An account's coverage starts on its first such day. The total is labelled
// partial on any day not every traded account covers, so it can be shown
// from the earliest trade without pretending to be all of net worth.
//
// Market value only: a synced brokerage's cash isn't in its trades, so this
// is its positions' worth, not its balance. Bank balances keep their own
// history (balance snapshots), which starts when syncing did.

export const MAX_CARRY_DAYS = 4;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type PricedTrade = Trade & { accountId: string };
export type ClosePrice = { symbol: string; on: string; price: string };

export type RebuiltAccount = {
  accountId: string;
  // The first day with a value, or null if no day could be valued.
  coverageStart: string | null;
  // One entry per day from the account's first trade through `through`; null where unknown.
  values: (number | null)[];
};

export type RebuiltHistory = {
  days: string[];
  accounts: RebuiltAccount[];
  // Per day: the sum over accounts with a value, and whether every account had one.
  total: { on: string; cents: number; complete: boolean; counted: number }[];
  // The first day every account is covered from on, or null.
  completeFrom: string | null;
};

/** The rebuild itself, pure: trades by account, and each symbol's closes. */
export function rebuild(tradesByAccount: Map<string, PricedTrade[]>, closes: Map<string, ClosePrice[]>, through: string): RebuiltHistory {
  const first = [...tradesByAccount.values()].flat().reduce<string | null>((m, t) => (m === null || t.on < m ? t.on : m), null);
  if (!first || first > through) return { days: [], accounts: [], total: [], completeFrom: null };
  const days: string[] = [];
  for (let d = first; d <= through; d = addDays(d, 1)) days.push(d);

  const priceOn = (symbol: string, day: string, cursor: Map<string, number>): string | null => {
    const list = closes.get(symbol) ?? [];
    let i = cursor.get(symbol) ?? -1;
    while (i + 1 < list.length && list[i + 1].on <= day) i++;
    cursor.set(symbol, i);
    if (i < 0) return null;
    return daysBetween(list[i].on, day) <= MAX_CARRY_DAYS ? list[i].price : null;
  };

  const rebuilt: RebuiltAccount[] = [];
  for (const [accountId, list] of tradesByAccount) {
    const ordered = inOrder(list);
    const values: (number | null)[] = [];
    const cursor = new Map<string, number>();
    const held = new Map<string, Trade[]>();
    let next = 0;
    let coverageStart: string | null = null;
    for (const day of days) {
      while (next < ordered.length && ordered[next].on <= day) {
        const t = ordered[next++];
        held.set(t.symbol, [...(held.get(t.symbol) ?? []), t]);
      }
      if (next === 0) {
        values.push(null);
        continue;
      }
      let cents = 0;
      let known = true;
      for (const [symbol, ts] of held) {
        // Quantity at the end of this day, exactly (a short sale, which a
        // partial log can show, is unknown, not negative wealth).
        const quantity = holdingsOn(ts).get(symbol) ?? "0";
        if (quantity === "0") continue;
        const price = priceOn(symbol, day, cursor);
        if (price === null || quantity.startsWith("-")) {
          known = false;
          break;
        }
        cents += positionValueCents(quantity, price);
      }
      values.push(known ? cents : null);
      if (known && coverageStart === null) coverageStart = day;
    }
    rebuilt.push({ accountId, coverageStart, values });
  }

  const total = days.map((on, i) => {
    const vals = rebuilt.map((a) => a.values[i]);
    const known = vals.filter((v): v is number => v !== null);
    return { on, cents: known.reduce((s, v) => s + v, 0), complete: known.length === rebuilt.length, counted: known.length };
  });
  const starts = rebuilt.map((a) => a.coverageStart);
  const completeFrom = starts.every((s) => s !== null) ? (starts as string[]).reduce((m, s) => (s > m ? s : m)) : null;
  return { days, accounts: rebuilt, total, completeFrom };
}

/**
 * The kind of asset each symbol is in each manual account (#244), from its
 * position, keyed "accountId:SYMBOL". A synced account's symbols are
 * equities. A symbol sold out of a manual account has no position left to
 * say, and is taken as crypto, as every manual position was before #244.
 */
export async function manualClasses(db: Db): Promise<Map<string, AssetClass>> {
  const rows = await db
    .select({ accountId: manualPositions.accountId, symbol: manualPositions.symbol, assetClass: manualPositions.assetClass })
    .from(manualPositions);
  return new Map(rows.map((r) => [`${r.accountId}:${r.symbol.toUpperCase()}`, r.assetClass]));
}

/** The rebuilt history for every account with trades, through `through` (YYYY-MM-DD). */
export async function rebuiltHistory(db: Db, through: string): Promise<RebuiltHistory> {
  const rows = await db
    .select({ trade: trades, source: accounts.source })
    .from(trades)
    .innerJoin(accounts, eq(accounts.id, trades.accountId));
  if (!rows.length) return { days: [], accounts: [], total: [], completeFrom: null };
  const classes = await manualClasses(db);
  const byAccount = new Map<string, PricedTrade[]>();
  const wanted = new Map<AssetClass, Set<string>>([["crypto", new Set()], ["equity", new Set()]]);
  // Each trade's symbol is keyed by its class, so the same ticker as a coin and as a stock never share prices.
  const keyOf = (assetClass: AssetClass, symbol: string) => `${assetClass}:${symbol}`;
  for (const { trade, source } of rows) {
    const assetClass: AssetClass = source === "manual" ? (classes.get(`${trade.accountId}:${trade.symbol}`) ?? "crypto") : "equity";
    byAccount.set(trade.accountId, [...(byAccount.get(trade.accountId) ?? []), { ...trade, accountId: trade.accountId, symbol: keyOf(assetClass, trade.symbol) }]);
    wanted.get(assetClass)!.add(trade.symbol);
  }
  const closes = new Map<string, ClosePrice[]>();
  for (const [assetClass, symbols] of wanted) {
    if (!symbols.size) continue;
    const prices = await db
      .select({ symbol: dailyPrices.symbol, on: dailyPrices.on, price: dailyPrices.price })
      .from(dailyPrices)
      .where(and(eq(dailyPrices.assetClass, assetClass), inArray(dailyPrices.symbol, [...symbols])))
      .orderBy(dailyPrices.on);
    for (const p of prices) closes.set(keyOf(assetClass, p.symbol), [...(closes.get(keyOf(assetClass, p.symbol)) ?? []), { ...p, symbol: keyOf(assetClass, p.symbol) }]);
  }
  return rebuild(byAccount, closes, through);
}
