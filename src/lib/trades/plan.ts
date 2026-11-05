import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { accounts, holdingSnapshots, tradeKindMemory, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { cashSignal } from "@/lib/trades/cash";
import { pairTransfers, planGaps, positionKey, tradeKey, type GapPlan, type GapPosition, type PlannedTrade } from "@/lib/trades/gaps";

// Loading what gap drafting (#320) needs, per synced investment account:
// its snapshots (cash left out) and every trade that counts for gaps. Used
// by the trades.draftGaps operation to write the plan, and by the sync
// (./draft-gaps.ts) to skip the operation, and an empty command in
// Activity, when there's nothing to do.

export type AccountPlan = { accountId: string; relabel: { id: string; side: "transfer_in" | "transfer_out"; pair: string }[] } & GapPlan;

export async function planTradeGaps(db: Db, accountId?: string): Promise<AccountPlan[]> {
  // Synced only: a manual account's positions are its trades (#231), so it never has a gap.
  const synced = await db
    .select({ id: accounts.id, baselineOn: accounts.tradesBaselineOn })
    .from(accounts)
    .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), ne(accounts.source, "manual"), accountId ? eq(accounts.id, accountId) : undefined));
  if (!synced.length) return [];
  const ids = synced.map((a) => a.id);
  const [snaps, logged, memory] = await Promise.all([
    db.select().from(holdingSnapshots).where(inArray(holdingSnapshots.accountId, ids)).orderBy(asc(holdingSnapshots.on)),
    // Confirmed, draft and dismissed all count (lib/trades/gaps.ts says why).
    db.select().from(trades).where(inArray(trades.accountId, ids)),
    db.select().from(tradeKindMemory).where(inArray(tradeKindMemory.accountId, ids)),
  ]);

  const plans = synced.map((a) => {
    const rows = snaps.filter((s) => s.accountId === a.id);
    // A position that ever looks like cash is cash on every day, so a sweep
    // fund priced a cent off $1.00 one day doesn't turn into a trade.
    const cash = new Set(rows.filter((s) => cashSignal(s)).map((s) => positionKey(s)));
    const byDay = new Map<string, GapPosition[]>();
    for (const s of rows) {
      const key = positionKey(s);
      if (cash.has(key)) continue;
      byDay.set(s.on, [...(byDay.get(s.on) ?? []), { key, symbol: s.symbol, externalId: s.externalId, shares: s.shares, marketValueCents: s.marketValueCents }]);
    }
    // A day where everything held was cash still happened.
    for (const s of rows) if (!byDay.has(s.on)) byDay.set(s.on, []);
    const days = [...byDay.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([on, positions]) => ({ on, positions }));
    const own = logged.filter((t) => t.accountId === a.id && !cash.has(tradeKey(t)));
    const remembered = (key: string, side: string) => memory.find((m) => m.accountId === a.id && m.position === key && m.side === side)?.kind;
    return {
      accountId: a.id,
      relabel: [] as AccountPlan["relabel"],
      ...planGaps({ days, trades: own.map((t) => ({ key: tradeKey(t), side: t.side, quantity: t.quantity, on: t.on })), baselineOn: a.baselineOn, remembered }),
    };
  });
  // Shares that left one account and arrived in another are one transfer
  // (#324), including a new draft's other end that's already waiting.
  const waiting = logged
    .filter((t) => t.status === "draft" && t.kind === "trade" && t.source === "position_gap" && !t.pairedTradeId && t.symbol)
    .map((t) => ({
      accountId: t.accountId,
      d: { key: tradeKey(t), symbol: t.symbol, positionId: t.positionId, side: t.side, quantity: t.quantity, on: t.on, onFrom: t.onFrom, kind: "trade", ratio: null, existingId: t.id } as PlannedTrade,
    }));
  pairTransfers(plans, waiting);
  for (const w of waiting)
    if (w.d.pair) plans.find((p) => p.accountId === w.accountId)?.relabel.push({ id: w.d.existingId!, side: w.d.side as "transfer_in" | "transfer_out", pair: w.d.pair });
  return plans;
}

/** Whether an account's plan writes anything. */
export const hasWork = (p: AccountPlan) => p.baseline !== null || p.drafts.length > 0 || p.relabel.length > 0;
