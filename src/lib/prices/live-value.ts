import { eq, inArray, sql } from "drizzle-orm";
import { accounts, holdingSnapshots, manualPositions } from "@/db/schema";
import type { Db } from "@/db/types";
import { positionValueCents } from "@/lib/holdings/value";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { latestQuotes, type Quote } from "@/lib/prices/quotes";
import type { AssetClass } from "@/lib/prices/source";

// An account's value between syncs (#230): its positions at the latest
// market price, so net worth moves with prices without waiting for the bank.
//
//   live = (balance − positions at their last value) + Σ quantity × latest price
//
// The first term is cash and other: whatever the balance holds beyond its
// positions, which stays put until the next sync. A position with no fresh
// price (none cached, none from the provider, or stale) stays at its last
// value and is named, never guessed and never zero. Worked out when read,
// never stored: net worth stays a read path.
//
// Two kinds of account have positions: a manual one with positions entered
// by hand (#231), whose last value is quantity × the owner's price, priced
// as crypto; and a synced brokerage or retirement account, whose last value
// is its newest holdings snapshot, priced as equities (Tiingo, once its key
// is set; until then those keep their balance).

export type LivePosition = { symbol: string; quantity: string; lastValueCents: number };

export type LiveValue = {
  valueCents: number;
  cashAndOtherCents: number;
  // The oldest market price used, so "prices as of" never overstates freshness. Null when none was used.
  pricesAsOf: Date | null;
  priced: number;
  // Positions left at their last value, by symbol.
  unpriced: string[];
};

/** The live value of one account from its balance, its positions and the fresh quotes. Pure. */
export function liveValue(balanceCents: number, positions: LivePosition[], quotes: Map<string, Quote>): LiveValue {
  const lastTotal = positions.reduce((s, p) => s + p.lastValueCents, 0);
  const cashAndOtherCents = balanceCents - lastTotal;
  let valueCents = cashAndOtherCents;
  let pricesAsOf: Date | null = null;
  const unpriced: string[] = [];
  for (const p of positions) {
    const q = quotes.get(p.symbol.toUpperCase());
    if (q && q.price !== null && !q.stale && q.asOf) {
      valueCents += positionValueCents(p.quantity, q.price);
      if (!pricesAsOf || q.asOf < pricesAsOf) pricesAsOf = q.asOf;
    } else {
      valueCents += p.lastValueCents;
      unpriced.push(p.symbol);
    }
  }
  return { valueCents, cashAndOtherCents, pricesAsOf, priced: positions.length - unpriced.length, unpriced };
}

/** Live values for every account with positions, by account id. Accounts without positions aren't in it. */
export async function liveValues(db: Db, { now = new Date() }: { now?: Date } = {}): Promise<Map<string, LiveValue>> {
  const [rows, manual, latestDays] = await Promise.all([
    db.select({ id: accounts.id, balanceCents: accounts.balanceCents, kind: accounts.type, source: accounts.source }).from(accounts),
    db.select().from(manualPositions),
    db
      .select({ accountId: holdingSnapshots.accountId, on: sql<string>`max(${holdingSnapshots.on})` })
      .from(holdingSnapshots)
      .innerJoin(accounts, eq(accounts.id, holdingSnapshots.accountId))
      .where(inArray(accounts.type, [...INVESTMENT_KINDS]))
      .groupBy(holdingSnapshots.accountId),
  ]);
  const synced = latestDays.length
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
  const quotes = new Map<AssetClass, Map<string, Quote>>([
    ["crypto", await latestQuotes(db, "crypto", { now })],
    ["equity", await latestQuotes(db, "equity", { now })],
  ]);

  const out = new Map<string, LiveValue>();
  for (const a of rows) {
    if (a.balanceCents === null) continue;
    const own = manual.filter((p) => p.accountId === a.id);
    const held = synced.filter((p) => p.accountId === a.id);
    if (own.length) {
      const positions = own.map((p) => ({ symbol: p.symbol, quantity: p.quantity, lastValueCents: positionValueCents(p.quantity, p.unitPrice) }));
      out.set(a.id, liveValue(a.balanceCents, positions, quotes.get("crypto")!));
    } else if (held.length) {
      // A position without a symbol can't be priced; it stays at its last value.
      const positions = held.map((p) => ({ symbol: p.symbol ?? `(${p.description})`, quantity: p.shares, lastValueCents: p.marketValueCents }));
      out.set(a.id, liveValue(a.balanceCents, positions, quotes.get("equity")!));
    }
  }
  return out;
}
