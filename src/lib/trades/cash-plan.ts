import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
import { accounts, dailyPrices, tradeHintDismissals, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { planCash, recognize, type CashPlan, type DraftForCash, type Recognized } from "@/lib/trades/cash-rows";

// Loading what cash-row matching (#321) needs: each synced investment
// account's buy and sell rows that aren't attached to a trade or dismissed
// as hints, its waiting drafts with no cash yet, and the daily prices to
// check amounts against. Used by trades.matchCash to attach, by the sync to
// skip it when there's nothing, and by the Trades page for offers and hints.

// The price for a day, or the latest before it within this many days (a weekend, a holiday).
const PRICE_LOOKBACK_DAYS = 5;

export async function planCashRows(db: Db): Promise<CashPlan & { rows: Map<string, Recognized> }> {
  // Only accounts gap drafting has started for (#320): rows from before an
  // account's baseline are what its opening trades already explain.
  const synced = await db
    .select({ id: accounts.id, baselineOn: accounts.tradesBaselineOn })
    .from(accounts)
    .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), ne(accounts.source, "manual"), isNotNull(accounts.tradesBaselineOn)));
  const empty = { attach: [], offers: new Map(), hints: [], rows: new Map() };
  if (!synced.length) return empty;
  const ids = synced.map((a) => a.id);
  const baseline = new Map(synced.map((a) => [a.id, a.baselineOn!]));

  const [cash, linked, dismissed, drafts] = await Promise.all([
    db
      .select({ id: transactions.id, accountId: transactions.accountId, postedOn: transactions.postedOn, amountCents: transactions.amountCents, description: transactions.description, payee: transactions.payee, memo: transactions.memo })
      .from(transactions)
      .where(and(inArray(transactions.accountId, ids), eq(transactions.pending, false))),
    db.select({ id: trades.transactionId }).from(trades).where(and(inArray(trades.accountId, ids), isNotNull(trades.transactionId))),
    db.select({ id: tradeHintDismissals.transactionId }).from(tradeHintDismissals),
    db
      .select({ id: trades.id, accountId: trades.accountId, side: trades.side, symbol: trades.symbol, quantity: trades.quantity, on: trades.on, onFrom: trades.onFrom })
      .from(trades)
      // A split or a share transfer has no cash to it (#324).
      .where(and(inArray(trades.accountId, ids), eq(trades.status, "draft"), isNull(trades.transactionId), notInArray(trades.kind, ["split", "transfer"]))),
  ]);
  const taken = new Set([...linked, ...dismissed].map((r) => r.id));
  const rows: Recognized[] = [];
  for (const t of cash) {
    if (taken.has(t.id) || t.postedOn <= baseline.get(t.accountId)!) continue;
    const r = recognize({ id: t.id, accountId: t.accountId, postedOn: t.postedOn, amountCents: t.amountCents, text: [t.description, t.payee, t.memo].filter(Boolean).join(" ") });
    if (r) rows.push(r);
  }
  if (!rows.length) return empty;

  // Synced accounts hold stocks and funds: equity prices (#244).
  const symbols = [...new Set(drafts.flatMap((d) => (d.symbol ? [d.symbol] : [])))];
  const earliest = rows.reduce((m, r) => (r.postedOn < m ? r.postedOn : m), rows[0].postedOn);
  const from = new Date(Date.parse(`${earliest}T00:00:00Z`) - PRICE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const prices = symbols.length
    ? await db
        .select({ symbol: dailyPrices.symbol, on: dailyPrices.on, price: dailyPrices.price })
        .from(dailyPrices)
        .where(and(eq(dailyPrices.assetClass, "equity"), inArray(dailyPrices.symbol, symbols), gt(dailyPrices.on, from)))
    : [];
  const priceOn = (symbol: string, day: string) => {
    const lower = new Date(Date.parse(`${day}T00:00:00Z`) - PRICE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const best = prices.filter((p) => p.symbol === symbol && p.on <= day && p.on >= lower).sort((a, b) => b.on.localeCompare(a.on))[0];
    return best ? Number(best.price) : null;
  };
  return { ...planCash(rows, drafts as DraftForCash[], priceOn), rows: new Map(rows.map((r) => [r.id, r])) };
}
