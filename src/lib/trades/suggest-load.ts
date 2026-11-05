import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { accounts, dailyPrices, holdingSnapshots, manualPositions, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { recognize, SETTLEMENT_DAYS } from "@/lib/trades/cash-rows";
import { quantityFor, suggest, type Close, type DraftFacts, type PositionDay, type Suggestion } from "@/lib/trades/suggest";
import type { AssetClass } from "@/lib/prices/source";

// Gathering what each draft's suggestions (#323) are worked out from, for
// the Trades page: the position before and at the end of its range, its
// cash row, closing prices, and symbols the cash rows around it name.

const LOOKBACK_DAYS = 5;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type DraftInput = { id: string; accountId: string; side: DraftFacts["side"]; quantity: string; symbol: string | null; positionId: string | null; on: string; onFrom: string | null; price: string | null; transactionId: string | null };
export type Suggested = { suggestions: Suggestion[]; notes: string[] };

/** Closing prices per symbol over a window, from the class that prices it. */
async function closesFor(db: Db, wanted: { assetClass: AssetClass; symbol: string; from: string; to: string }[]): Promise<(assetClass: AssetClass, symbol: string) => Close[]> {
  if (!wanted.length) return () => [];
  const from = wanted.reduce((m, w) => (w.from < m ? w.from : m), wanted[0].from);
  const to = wanted.reduce((m, w) => (w.to > m ? w.to : m), wanted[0].to);
  const rows = await db
    .select({ assetClass: dailyPrices.assetClass, symbol: dailyPrices.symbol, on: dailyPrices.on, price: dailyPrices.price })
    .from(dailyPrices)
    .where(and(inArray(dailyPrices.symbol, [...new Set(wanted.map((w) => w.symbol))]), gte(dailyPrices.on, from), lte(dailyPrices.on, to)));
  return (assetClass, symbol) => rows.filter((r) => r.assetClass === assetClass && r.symbol === symbol).map((r) => ({ on: r.on, price: Number(r.price) }));
}

export async function suggestionsFor(db: Db, drafts: DraftInput[]): Promise<Map<string, Suggested>> {
  if (!drafts.length) return new Map();
  const accountIds = [...new Set(drafts.map((d) => d.accountId))];
  const earliest = drafts.reduce((m, d) => ((d.onFrom ?? d.on) < m ? (d.onFrom ?? d.on) : m), drafts[0].onFrom ?? drafts[0].on);
  const latest = drafts.reduce((m, d) => (d.on > m ? d.on : m), drafts[0].on);
  const cashIds = drafts.flatMap((d) => (d.transactionId ? [d.transactionId] : []));
  const [accts, snaps, rows, attached, manual] = await Promise.all([
    db.select({ id: accounts.id, source: accounts.source }).from(accounts).where(inArray(accounts.id, accountIds)),
    db.select().from(holdingSnapshots).where(and(inArray(holdingSnapshots.accountId, accountIds), lte(holdingSnapshots.on, latest))),
    db
      .select({ id: transactions.id, accountId: transactions.accountId, postedOn: transactions.postedOn, amountCents: transactions.amountCents, description: transactions.description, payee: transactions.payee, memo: transactions.memo })
      .from(transactions)
      .where(and(inArray(transactions.accountId, accountIds), gte(transactions.postedOn, shift(earliest, -SETTLEMENT_DAYS)), lte(transactions.postedOn, shift(latest, SETTLEMENT_DAYS)), eq(transactions.pending, false))),
    cashIds.length ? db.select({ id: transactions.id, amountCents: transactions.amountCents }).from(transactions).where(inArray(transactions.id, cashIds)) : Promise.resolve([]),
    db.select({ accountId: manualPositions.accountId, symbol: manualPositions.symbol, assetClass: manualPositions.assetClass }).from(manualPositions).where(inArray(manualPositions.accountId, accountIds)),
  ]);
  const isManual = new Set(accts.filter((a) => a.source === "manual").map((a) => a.id));
  // Synced accounts hold stocks and funds; a manual one says per position, coins by default (#244).
  const classOf = (accountId: string, symbol: string): AssetClass =>
    isManual.has(accountId) ? (manual.find((m) => m.accountId === accountId && m.symbol.toUpperCase() === symbol)?.assetClass ?? "crypto") : "equity";
  const closes = await closesFor(
    db,
    drafts.flatMap((d) => (d.symbol ? [{ assetClass: classOf(d.accountId, d.symbol), symbol: d.symbol, from: shift(d.onFrom ?? d.on, -LOOKBACK_DAYS), to: d.on }] : [])),
  );
  const amount = new Map(attached.map((a) => [a.id, a.amountCents]));
  const seen = rows.flatMap((r) => {
    const x = recognize({ id: r.id, accountId: r.accountId, postedOn: r.postedOn, amountCents: r.amountCents, text: [r.description, r.payee, r.memo].filter(Boolean).join(" ") });
    return x ? [x] : [];
  });

  const out = new Map<string, Suggested>();
  for (const d of drafts) {
    // The draft's position: by its id when it has no symbol (#320), else by symbol.
    const mine = snaps.filter((s) => s.accountId === d.accountId && (d.positionId ? s.externalId === d.positionId : s.symbol?.toUpperCase() === d.symbol));
    const day = (s: (typeof snaps)[number]): PositionDay => ({ on: s.on, shares: s.shares, marketValueCents: s.marketValueCents, costBasisCents: s.costBasisCents });
    const start = d.onFrom ?? d.on;
    const before = mine.filter((s) => s.on < start).sort((a, b) => b.on.localeCompare(a.on))[0];
    const after = mine.filter((s) => s.on <= d.on).sort((a, b) => b.on.localeCompare(a.on))[0];
    const side = d.side === "sell" || d.side === "transfer_out" ? "sell" : "buy";
    out.set(
      d.id,
      suggest({
        side: d.side,
        quantity: d.quantity,
        symbol: d.symbol,
        on: d.on,
        onFrom: d.onFrom,
        price: d.price,
        before: before ? day(before) : null,
        after: after && after.on >= start ? day(after) : null,
        cashCents: d.transactionId ? (amount.get(d.transactionId) ?? null) : null,
        closes: d.symbol ? closes(classOf(d.accountId, d.symbol), d.symbol) : [],
        namedSymbols: seen
          .filter((r) => r.accountId === d.accountId && r.side === side && r.symbol && r.postedOn >= shift(start, -SETTLEMENT_DAYS) && r.postedOn <= shift(d.on, SETTLEMENT_DAYS))
          .map((r) => ({ symbol: r.symbol!, on: r.postedOn })),
      }),
    );
  }
  return out;
}

/** For cash-only hints that name a symbol but no quantity: about how many shares the amount bought. */
export async function hintQuantities(db: Db, hints: { id: string; postedOn: string; amountCents: number; symbol: string | null; quantity: string | null }[]): Promise<Map<string, Suggestion>> {
  const open = hints.filter((h) => h.symbol && !h.quantity);
  const closes = await closesFor(db, open.map((h) => ({ assetClass: "equity" as const, symbol: h.symbol!, from: shift(h.postedOn, -LOOKBACK_DAYS), to: h.postedOn })));
  const out = new Map<string, Suggestion>();
  for (const h of open) {
    const close = closes("equity", h.symbol!).filter((c) => c.on <= h.postedOn).sort((a, b) => b.on.localeCompare(a.on))[0] ?? null;
    const q = quantityFor(h.amountCents, close);
    if (q) out.set(h.id, q);
  }
  return out;
}
