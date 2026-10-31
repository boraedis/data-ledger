import { and, eq, inArray, lte } from "drizzle-orm";
import { accounts, balanceSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { NET_WORTH_CURRENCY } from "@/lib/net-worth";

// How much investment accounts' value changed over a period (#169), shown
// beside cash flow but never in it: growth and contributions alike move it,
// and neither is cash in or out of spending. From balance snapshots, so it
// stays in the library with net worth, never an operation (balances don't
// go through the operations layer).

/** Each investment account's balance at the end of `to` less its balance at the end of the day before `from`; null without both for any account. */
export function valueChange(snapshots: { accountId: string; on: string; balanceCents: number }[], from: string, to: string): number | null {
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const byAccount = new Map<string, { on: string; balanceCents: number }[]>();
  for (const s of snapshots) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  let change: number | null = null;
  for (const list of byAccount.values()) {
    const sorted = [...list].sort((a, b) => a.on.localeCompare(b.on));
    const at = (day: string) => sorted.findLast((s) => s.on <= day)?.balanceCents;
    const end = at(to);
    const start = at(dayBefore);
    // An account opened during the period counts from zero.
    if (end === undefined) continue;
    change = (change ?? 0) + end - (start ?? 0);
  }
  return change;
}

export async function investmentChange(db: Db, { from, to }: { from: string; to: string }): Promise<number | null> {
  const ids = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), eq(accounts.currency, NET_WORTH_CURRENCY)));
  const snapshots = await db
    .select({ accountId: balanceSnapshots.accountId, on: balanceSnapshots.on, balanceCents: balanceSnapshots.balanceCents })
    .from(balanceSnapshots)
    .where(and(inArray(balanceSnapshots.accountId, ids), lte(balanceSnapshots.on, to)));
  return valueChange(snapshots, from, to);
}
