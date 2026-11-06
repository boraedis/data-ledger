import { and, eq, isNotNull } from "drizzle-orm";
import { accounts, holdingSnapshots, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { cashSignal } from "@/lib/trades/cash";
import type { BrokerageRow } from "@/lib/trades/import-csv";
import { moveBaseline, planImport, type BaselineMove, type PlannedRow } from "@/lib/trades/import-plan";

// What a brokerage import (#355) is checked against, read for one account:
// its cash rows, its trades, the symbols it holds as cash, its baseline and
// openings. For the preview (#357) and for trades.import (#356), which
// plans again on apply so nothing changed in between is missed.

export type ImportPreview = { rows: PlannedRow[]; baseline: BaselineMove | null };

export async function previewBrokerageImport(db: Db, accountId: string, rows: BrokerageRow[], ticked?: Set<string>): Promise<ImportPreview> {
  const [[account], cash, linked, all, snaps] = await Promise.all([
    db.select({ baselineOn: accounts.tradesBaselineOn }).from(accounts).where(eq(accounts.id, accountId)),
    db
      .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents, description: transactions.description, externalId: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.accountId, accountId)),
    db.select({ transactionId: trades.transactionId }).from(trades).where(and(eq(trades.accountId, accountId), isNotNull(trades.transactionId))),
    db.select().from(trades).where(eq(trades.accountId, accountId)),
    db
      .select({ symbol: holdingSnapshots.symbol, description: holdingSnapshots.description, shares: holdingSnapshots.shares, marketValueCents: holdingSnapshots.marketValueCents })
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.accountId, accountId)),
  ]);
  if (!account) throw new Error("Account not found");
  const withTrade = new Set(linked.map((l) => l.transactionId));
  // Imported before: a cash row carries its stable ID as external ID, and
  // a trade as its import key (#356), so a split with no cash is known too.
  const importedIds = new Set([
    ...cash.filter((c) => c.externalId?.startsWith("brk:")).map((c) => c.externalId!),
    ...all.flatMap((t) => (t.importKey ? [t.importKey] : [])),
  ]);
  const planned = planImport({
    rows,
    importedIds,
    // A row an earlier import added is matched by its ID, not as "already here".
    existingCash: cash.filter((c) => !c.externalId?.startsWith("brk:")).map((c) => ({ ...c, hasTrade: withTrade.has(c.id) })),
    trades: all,
    cashFunds: new Set(snaps.filter((s) => s.symbol && cashSignal(s)).map((s) => s.symbol!.toUpperCase())),
  });
  // The baseline moves for what will be imported: the owner's ticks, or the preview's own.
  const going = planned.filter((r) => (ticked ? ticked.has(r.id) : r.ticked) && (r.tradePlan?.status === "new" || r.tradePlan?.status === "fills_draft"));
  const baseline = moveBaseline({
    baselineOn: account.baselineOn,
    openings: all.filter((t) => t.source === "opening" && t.status === "confirmed" && t.symbol).map((t) => ({ id: t.id, symbol: t.symbol!, side: t.side, quantity: t.quantity })),
    imported: going.map((r) => r.trade!),
  });
  return { rows: planned, baseline };
}
