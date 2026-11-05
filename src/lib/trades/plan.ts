import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { accounts, holdingSnapshots, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { cashSignal } from "@/lib/trades/cash";
import { planGaps, positionKey, tradeKey, type GapPlan, type GapPosition } from "@/lib/trades/gaps";

// Loading what gap drafting (#320) needs, per synced investment account:
// its snapshots (cash left out) and every trade that counts for gaps. Used
// by the trades.draftGaps operation to write the plan, and by the sync
// (./draft-gaps.ts) to skip the operation, and an empty command in
// Activity, when there's nothing to do.

export type AccountPlan = { accountId: string } & GapPlan;

export async function planTradeGaps(db: Db, accountId?: string): Promise<AccountPlan[]> {
  // Synced only: a manual account's positions are its trades (#231), so it never has a gap.
  const synced = await db
    .select({ id: accounts.id, baselineOn: accounts.tradesBaselineOn })
    .from(accounts)
    .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), ne(accounts.source, "manual"), accountId ? eq(accounts.id, accountId) : undefined));
  if (!synced.length) return [];
  const ids = synced.map((a) => a.id);
  const [snaps, logged] = await Promise.all([
    db.select().from(holdingSnapshots).where(inArray(holdingSnapshots.accountId, ids)).orderBy(asc(holdingSnapshots.on)),
    // Confirmed, draft and dismissed all count (lib/trades/gaps.ts says why).
    db.select().from(trades).where(inArray(trades.accountId, ids)),
  ]);

  return synced.map((a) => {
    const rows = snaps.filter((s) => s.accountId === a.id);
    // A position that ever looks like cash is cash on every day, so a sweep
    // fund priced a cent off $1.00 one day doesn't turn into a trade.
    const cash = new Set(rows.filter((s) => cashSignal(s)).map((s) => positionKey(s)));
    const byDay = new Map<string, GapPosition[]>();
    for (const s of rows) {
      const key = positionKey(s);
      if (cash.has(key)) continue;
      byDay.set(s.on, [...(byDay.get(s.on) ?? []), { key, symbol: s.symbol, externalId: s.externalId, shares: s.shares }]);
    }
    // A day where everything held was cash still happened.
    for (const s of rows) if (!byDay.has(s.on)) byDay.set(s.on, []);
    const days = [...byDay.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([on, positions]) => ({ on, positions }));
    const own = logged.filter((t) => t.accountId === a.id && !cash.has(tradeKey(t)));
    return { accountId: a.id, ...planGaps({ days, trades: own.map((t) => ({ key: tradeKey(t), side: t.side, quantity: t.quantity, on: t.on })), baselineOn: a.baselineOn }) };
  });
}

/** Whether an account's plan writes anything. */
export const hasWork = (p: AccountPlan) => p.baseline !== null || p.drafts.length > 0;
