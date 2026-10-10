import { asc } from "drizzle-orm";
import { accounts, balanceSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import type { AccountKind } from "@/lib/account-kinds";

// Net worth = assets − liabilities, from account balances (#25).
//
// Deliberately not an operation: every registered read becomes one of
// Tally's tools, and balances never go to a model (AGENTS.md). Pages call
// this directly; it only reads.
//
// Sign convention. Providers disagree on how to report what you owe: some
// send a credit card balance of -500.00, others 500.00 for the same debt.
// So a liability kind (credit, loan) always counts as what's owed:
// −|balance|. Every other kind counts as reported, so an overdrawn checking
// account is negative, as it should be. The cost is one known edge case: a
// card with a credit balance (overpaid, or a refund larger than the bill)
// counts as a small debt instead of a small asset. Stored balances are
// never rewritten; the convention applies when reading, so changing an
// account's kind corrects its history too.

export const LIABILITY_KINDS: readonly AccountKind[] = ["credit", "loan"];

export function isLiability(kind: AccountKind): boolean {
  return LIABILITY_KINDS.includes(kind);
}

/** What one balance adds to net worth, in cents: negative for anything owed. */
export function netWorthContribution(kind: AccountKind, balanceCents: number): number {
  return isLiability(kind) ? -Math.abs(balanceCents) : balanceCents;
}

// Only one currency is summed. Adding dollars to euros needs exchange
// rates the app doesn't have; an account in another currency is listed
// but left out of the totals, and the page says so.
export const NET_WORTH_CURRENCY = "USD";

export type NetWorthAccount = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  currency: string;
  balanceCents: number | null;
  balanceAt: Date | null;
};

export type NetWorthPoint = { on: string; assetsCents: number; liabilitiesCents: number; netCents: number };

type Snapshot = { accountId: string; on: string; balanceCents: number };

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One point per day from the first snapshot to `through`. An account's
 * balance carries forward from its last snapshot until the next one — a day
 * without a sync means "no news", not "zero". Before an account's first
 * snapshot it contributes nothing, since nothing is known.
 */
export function netWorthSeries(
  accountKinds: Map<string, AccountKind>,
  snapshots: Snapshot[],
  through: string,
): NetWorthPoint[] {
  const included = snapshots.filter((s) => accountKinds.has(s.accountId)).sort((a, b) => a.on.localeCompare(b.on));
  if (included.length === 0) return [];

  const latest = new Map<string, number>();
  const points: NetWorthPoint[] = [];
  let i = 0;
  const end = included.at(-1)!.on > through ? included.at(-1)!.on : through;
  for (let day = included[0].on; day <= end; day = addDays(day, 1)) {
    while (i < included.length && included[i].on <= day) {
      latest.set(included[i].accountId, included[i].balanceCents);
      i++;
    }
    let assetsCents = 0;
    let liabilitiesCents = 0;
    for (const [accountId, balance] of latest) {
      const value = netWorthContribution(accountKinds.get(accountId)!, balance);
      if (isLiability(accountKinds.get(accountId)!)) liabilitiesCents += -value;
      else assetsCents += value;
    }
    points.push({ on: day, assetsCents, liabilitiesCents, netCents: assetsCents - liabilitiesCents });
  }
  return points;
}

export type NetWorthSummary = {
  currency: string;
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
  byKind: { kind: AccountKind; cents: number; accounts: number }[];
  accounts: (NetWorthAccount & { contributionCents: number | null })[];
  // Accounts left out of the totals, and why.
  excluded: { account: NetWorthAccount; reason: "currency" | "no balance" }[];
  series: NetWorthPoint[];
};

export async function netWorthSummary(db: Db, { today = new Date() }: { today?: Date } = {}): Promise<NetWorthSummary> {
  const [rows, snapshots] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        displayName: accounts.displayName,
        institution: accounts.institution,
        kind: accounts.type,
        currency: accounts.currency,
        balanceCents: accounts.balanceCents,
        balanceAt: accounts.balanceAt,
      })
      .from(accounts),
    db
      .select({ accountId: balanceSnapshots.accountId, on: balanceSnapshots.on, balanceCents: balanceSnapshots.balanceCents })
      .from(balanceSnapshots)
      .orderBy(asc(balanceSnapshots.on)),
  ]);

  const all: NetWorthAccount[] = rows.map(({ displayName, name, ...rest }) => ({ ...rest, name: displayName ?? name }));
  const excluded: NetWorthSummary["excluded"] = [];
  const counted: (NetWorthAccount & { contributionCents: number | null })[] = [];
  for (const account of all) {
    if (account.currency !== NET_WORTH_CURRENCY) excluded.push({ account, reason: "currency" });
    else if (account.balanceCents === null) excluded.push({ account, reason: "no balance" });
    else counted.push({ ...account, contributionCents: netWorthContribution(account.kind, account.balanceCents) });
  }

  let assetsCents = 0;
  let liabilitiesCents = 0;
  const byKind = new Map<AccountKind, { cents: number; accounts: number }>();
  for (const a of counted) {
    const value = a.contributionCents!;
    if (isLiability(a.kind)) liabilitiesCents += -value;
    else assetsCents += value;
    const entry = byKind.get(a.kind) ?? { cents: 0, accounts: 0 };
    byKind.set(a.kind, { cents: entry.cents + value, accounts: entry.accounts + 1 });
  }

  const kinds = new Map(counted.map((a) => [a.id, a.kind]));
  return {
    currency: NET_WORTH_CURRENCY,
    assetsCents,
    liabilitiesCents,
    netCents: assetsCents - liabilitiesCents,
    byKind: [...byKind].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.cents - a.cents),
    accounts: counted.sort((a, b) => (b.contributionCents ?? 0) - (a.contributionCents ?? 0)),
    excluded,
    series: netWorthSeries(kinds, snapshots, today.toISOString().slice(0, 10)),
  };
}
