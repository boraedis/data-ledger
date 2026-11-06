import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { accounts, balanceSnapshots, holdingSnapshots, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { cashSignal, isCashMove } from "@/lib/trades/cash";
import type { DaySnapshot } from "@/lib/prices/rebuilt";

// A synced brokerage's cash in the past (#375). Its recorded balance is
// positions plus cash, but balances only start when syncing did, and trades
// (#232) only know the positions. The cash is what's left:
//
//   cash on the anchor day = the balance then - what its non-cash positions
//   were worth then (the sweep fund is cash, so it isn't subtracted)
//
// and every earlier day is walked back from there through the account's
// transactions: the cash at the end of day D is the cash at the end of the
// next day minus what posted on that next day. Deposits, withdrawals,
// transfers, dividends, fees and the cash side of trades all count; a row
// that only moves money into or out of the account's own cash fund (a sweep)
// doesn't change the total, so it's left out.
//
// Nothing is guessed, and what the ledger can't know is said. A brokerage's
// export has no deposits or withdrawals, so the owner adds those by hand as
// transactions on the account (#64). Until then the walk is off, in a way it
// can tell the owner about:
// - a withdrawal it doesn't know of makes the walk go below zero, which cash
//   can't; every day up to the last such one is left out, and the shortfall
//   is reported (`missing`);
// - a deposit it doesn't know of leaves the walk with more cash than there
//   was, which only shows as cash on the first day (`start`): if the account
//   held less than that then, the difference is deposits missing.

export type CashMovement = { on: string; cents: number };

export type CashProjection = {
  // Cash at the end of each day from `from` up to the day before the anchor,
  // oldest first, and only the days after the last one that went negative.
  days: { on: string; cents: number }[];
  // Set when the walk went below zero: at least this much came in on or
  // before `by` that no transaction accounts for.
  missing: { cents: number; by: string } | null;
  // The cash the walk ends on, at the end of its first day: what the account
  // held then if every movement is known. Null if no day is drawn.
  start: { on: string; cents: number } | null;
};

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The pure walk: cash on `anchorOn`, back through `movements`, over `from` to the day before the anchor. */
export function projectCash({ anchorOn, anchorCents, movements, from }: { anchorOn: string; anchorCents: number; movements: CashMovement[]; from: string }): CashProjection {
  if (from >= anchorOn) return { days: [], missing: null, start: null };
  const byDay = new Map<string, number>();
  for (const m of movements) if (m.on <= anchorOn) byDay.set(m.on, (byDay.get(m.on) ?? 0) + m.cents);
  // Newest first: the end of `day` is the end of the day after it, less what posted on that day after it.
  const walked: { on: string; cents: number }[] = [];
  let cents = anchorCents;
  for (let day = anchorOn; day > from; ) {
    cents -= byDay.get(day) ?? 0;
    day = addDays(day, -1);
    walked.push({ on: day, cents });
  }
  // The latest day the cash is below zero: nothing on or before it can be trusted.
  const negative = walked.reduce<{ on: string; cents: number } | null>((m, d) => (d.cents < 0 && (m === null || d.on > m.on) ? d : m), null);
  const worst = walked.reduce((m, d) => Math.min(m, d.cents), 0);
  const days = walked.filter((d) => !negative || d.on > negative.on).reverse();
  return { days, missing: negative ? { cents: -worst, by: negative.on } : null, start: days[0] ?? null };
}

export type AccountCash = {
  accountId: string;
  // The day the cash is anchored on: the earliest recorded balance that has its positions recorded too.
  anchorOn: string;
  // The earliest recorded balance: days before it have nothing recorded, so they're what's drawn.
  recordedFrom: string;
  cashCents: number;
  projection: CashProjection;
};

/**
 * Each synced investment account's cash in the past, from its first
 * recorded balance back to `from` (the earliest trade). An account with no
 * day that has both a balance and its positions has no anchor and is left
 * out; so is one whose positions are worth more than its balance.
 */
export async function accountCash(db: Db, from: string, accountIds?: string[]): Promise<AccountCash[]> {
  if (accountIds && !accountIds.length) return [];
  const synced = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), ne(accounts.source, "manual"), accountIds ? inArray(accounts.id, accountIds) : undefined));
  if (!synced.length) return [];
  const ids = synced.map((a) => a.id);
  const [balances, holdings, rows] = await Promise.all([
    db.select({ accountId: balanceSnapshots.accountId, on: balanceSnapshots.on, cents: balanceSnapshots.balanceCents }).from(balanceSnapshots).where(inArray(balanceSnapshots.accountId, ids)).orderBy(asc(balanceSnapshots.on)),
    db.select().from(holdingSnapshots).where(inArray(holdingSnapshots.accountId, ids)),
    // Pending rows aren't in the balance yet.
    db
      .select({ accountId: transactions.accountId, on: transactions.postedOn, cents: transactions.amountCents, description: transactions.description })
      .from(transactions)
      .where(and(inArray(transactions.accountId, ids), eq(transactions.pending, false))),
  ]);

  const out: AccountCash[] = [];
  for (const id of ids) {
    const own = balances.filter((b) => b.accountId === id);
    if (!own.length) continue;
    const held = holdings.filter((h) => h.accountId === id);
    const anchor = own.find((b) => held.some((h) => h.on === b.on));
    if (!anchor) continue;
    // A position that ever looks like cash is cash on every day (lib/trades/plan.ts says why).
    const cashKeys = new Set(held.filter((h) => cashSignal(h)).map((h) => h.externalId));
    const positions = held.filter((h) => h.on === anchor.on && !cashKeys.has(h.externalId)).reduce((s, h) => s + h.marketValueCents, 0);
    const cashCents = anchor.cents - positions;
    if (cashCents < 0) continue;
    const movements = rows.filter((r) => r.accountId === id && !isCashMove(r.description)).map((r) => ({ on: r.on, cents: r.cents }));
    out.push({ accountId: id, anchorOn: anchor.on, recordedFrom: own[0].on, cashCents, projection: projectCash({ anchorOn: anchor.on, anchorCents: cashCents, movements, from }) });
  }
  return out;
}

/**
 * Positions from trades plus cash from the walk, for the days before an
 * account's first recorded balance. A day needs both: positions the prices
 * can value, and cash the ledger accounts for.
 */
export function pastBalances(cash: AccountCash[], positions: { accountId: string; days: string[]; values: (number | null)[] }[]): DaySnapshot[] {
  const out: DaySnapshot[] = [];
  for (const c of cash) {
    const p = positions.find((x) => x.accountId === c.accountId);
    if (!p) continue;
    const cashOn = new Map(c.projection.days.map((d) => [d.on, d.cents]));
    p.days.forEach((on, i) => {
      const value = p.values[i];
      const cents = cashOn.get(on);
      if (on < c.recordedFrom && value !== null && cents !== undefined) out.push({ accountId: c.accountId, on, balanceCents: value + cents });
    });
  }
  return out;
}
