import { asc, inArray, sql, sum } from "drizzle-orm";
import { accounts, balanceSnapshots, holdingSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import type { AccountKind } from "@/lib/account-kinds";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { NET_WORTH_CURRENCY } from "@/lib/net-worth";

// The investments view (#27): allocation, value and cost basis, built from
// balance and holding snapshots. Display only — no advice, no projections.
//
// Not an operation, like net worth: every registered read is a Tally tool,
// and balances and holdings never go to a model (AGENTS.md).
//
// An account's value is its balance, as everywhere else. Holdings are what
// the brokerage says it's made of; whatever the balance has beyond them is
// shown as "cash and other" (uninvested cash, or positions the provider
// didn't list). Holdings are never added to the balance.

export type Position = {
  externalId: string;
  symbol: string | null;
  description: string;
  shares: string; // exact decimal
  marketValueCents: number;
  costBasisCents: number | null;
  // Unrealized gain or loss, only where the brokerage gave a cost basis.
  gainCents: number | null;
};

export type InvestmentAccount = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  manual: boolean;
  valueCents: number;
  // When the provider (or the owner, for a manual account) last reported the balance.
  balanceAt: Date | null;
  // The day of the newest holdings snapshot, or null if none was ever reported.
  holdingsOn: string | null;
  positions: Position[];
  // Balance not accounted for by the listed positions. Null without holdings.
  cashAndOtherCents: number | null;
  series: { on: string; cents: number; holdingsCents: number | null }[];
};

export type AllocationSlice = { label: string; cents: number; share: number };

export type InvestmentsSummary = {
  currency: string;
  totalCents: number;
  accounts: InvestmentAccount[];
  // Accounts left out of totals (another currency, or no balance yet).
  excluded: { name: string; reason: "currency" | "no balance" }[];
  byAccount: AllocationSlice[];
  // Positions combined across accounts by symbol (or description when
  // there's no symbol), plus cash and other, plus whole accounts whose
  // provider doesn't list positions.
  byHolding: AllocationSlice[];
  // Totals over positions that have a cost basis; positions without one are
  // counted separately so the gain is never overstated.
  withBasis: { marketValueCents: number; costBasisCents: number; gainCents: number; positions: number };
  positionsWithoutBasis: number;
};

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Daily values from the first snapshot through `through`, carrying the last known balance forward. */
export function dailySeries(
  balances: { on: string; cents: number }[],
  holdingsByDay: Map<string, number>,
  through: string,
): InvestmentAccount["series"] {
  if (balances.length === 0) return [];
  const sorted = [...balances].sort((a, b) => a.on.localeCompare(b.on));
  const series: InvestmentAccount["series"] = [];
  let i = 0;
  let current = sorted[0].cents;
  const end = sorted.at(-1)!.on > through ? sorted.at(-1)!.on : through;
  for (let day = sorted[0].on; day <= end; day = addDays(day, 1)) {
    while (i < sorted.length && sorted[i].on <= day) current = sorted[i++].cents;
    series.push({ on: day, cents: current, holdingsCents: holdingsByDay.get(day) ?? null });
  }
  return series;
}

function slices(entries: { label: string; cents: number }[], total: number): AllocationSlice[] {
  return entries
    .filter((e) => e.cents !== 0)
    .map((e) => ({ ...e, share: total > 0 ? e.cents / total : 0 }))
    .sort((a, b) => b.cents - a.cents);
}

export async function investmentsSummary(db: Db, { today = new Date() }: { today?: Date } = {}): Promise<InvestmentsSummary> {
  const rows = await db
    .select()
    .from(accounts)
    .where(inArray(accounts.type, [...INVESTMENT_KINDS]))
    .orderBy(accounts.institution, accounts.name);

  const excluded: InvestmentsSummary["excluded"] = [];
  const counted = rows.filter((a) => {
    const name = a.displayName ?? a.name;
    if (a.currency !== NET_WORTH_CURRENCY) excluded.push({ name, reason: "currency" });
    else if (a.balanceCents === null) excluded.push({ name, reason: "no balance" });
    else return true;
    return false;
  });
  const ids = counted.map((a) => a.id);
  if (ids.length === 0) {
    return {
      currency: NET_WORTH_CURRENCY,
      totalCents: 0,
      accounts: [],
      excluded,
      byAccount: [],
      byHolding: [],
      withBasis: { marketValueCents: 0, costBasisCents: 0, gainCents: 0, positions: 0 },
      positionsWithoutBasis: 0,
    };
  }

  const [balances, holdingTotals, latestDays] = await Promise.all([
    db
      .select({ accountId: balanceSnapshots.accountId, on: balanceSnapshots.on, cents: balanceSnapshots.balanceCents })
      .from(balanceSnapshots)
      .where(inArray(balanceSnapshots.accountId, ids))
      .orderBy(asc(balanceSnapshots.on)),
    db
      .select({ accountId: holdingSnapshots.accountId, on: holdingSnapshots.on, cents: sum(holdingSnapshots.marketValueCents).mapWith(Number) })
      .from(holdingSnapshots)
      .where(inArray(holdingSnapshots.accountId, ids))
      .groupBy(holdingSnapshots.accountId, holdingSnapshots.on),
    db
      .select({ accountId: holdingSnapshots.accountId, on: sql<string>`max(${holdingSnapshots.on})` })
      .from(holdingSnapshots)
      .where(inArray(holdingSnapshots.accountId, ids))
      .groupBy(holdingSnapshots.accountId),
  ]);
  const latestPositions = latestDays.length
    ? await db
        .select()
        .from(holdingSnapshots)
        .where(
          sql`(${holdingSnapshots.accountId}, ${holdingSnapshots.on}) in (${sql.join(
            latestDays.map((d) => sql`(${d.accountId}::uuid, ${d.on}::date)`),
            sql`, `,
          )})`,
        )
    : [];

  const through = today.toISOString().slice(0, 10);
  const result: InvestmentAccount[] = counted.map((a) => {
    const holdingsOn = latestDays.find((d) => d.accountId === a.id)?.on ?? null;
    const positions: Position[] = latestPositions
      .filter((p) => p.accountId === a.id)
      .map((p) => ({
        externalId: p.externalId,
        symbol: p.symbol,
        description: p.description,
        shares: p.shares,
        marketValueCents: p.marketValueCents,
        costBasisCents: p.costBasisCents,
        gainCents: p.costBasisCents === null ? null : p.marketValueCents - p.costBasisCents,
      }))
      .sort((x, y) => y.marketValueCents - x.marketValueCents);
    const holdingsCents = positions.reduce((s, p) => s + p.marketValueCents, 0);
    const byDay = new Map(holdingTotals.filter((h) => h.accountId === a.id).map((h) => [h.on, h.cents]));
    return {
      id: a.id,
      name: a.displayName ?? a.name,
      institution: a.institution,
      kind: a.type,
      manual: a.source === "manual",
      valueCents: a.balanceCents!,
      balanceAt: a.balanceAt,
      holdingsOn,
      positions,
      cashAndOtherCents: holdingsOn ? a.balanceCents! - holdingsCents : null,
      series: dailySeries(
        balances.filter((b) => b.accountId === a.id),
        byDay,
        through,
      ),
    };
  });

  const totalCents = result.reduce((s, a) => s + a.valueCents, 0);

  const holdingBuckets = new Map<string, number>();
  const add = (label: string, cents: number) => holdingBuckets.set(label, (holdingBuckets.get(label) ?? 0) + cents);
  let withBasisMv = 0;
  let withBasisCost = 0;
  let withBasisCount = 0;
  let withoutBasis = 0;
  for (const a of result) {
    if (!a.holdingsOn) {
      add(`${a.name} (positions not reported)`, a.valueCents);
      continue;
    }
    for (const p of a.positions) {
      add(p.symbol ?? p.description, p.marketValueCents);
      if (p.costBasisCents === null) withoutBasis++;
      else {
        withBasisMv += p.marketValueCents;
        withBasisCost += p.costBasisCents;
        withBasisCount++;
      }
    }
    if (a.cashAndOtherCents) add("Cash and other", a.cashAndOtherCents);
  }

  return {
    currency: NET_WORTH_CURRENCY,
    totalCents,
    accounts: result,
    excluded,
    byAccount: slices(result.map((a) => ({ label: a.name, cents: a.valueCents })), totalCents),
    byHolding: slices([...holdingBuckets].map(([label, cents]) => ({ label, cents })), totalCents),
    withBasis: { marketValueCents: withBasisMv, costBasisCents: withBasisCost, gainCents: withBasisMv - withBasisCost, positions: withBasisCount },
    positionsWithoutBasis: withoutBasis,
  };
}

