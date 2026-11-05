import { and, desc, eq, min, ne, sql } from "drizzle-orm";
import { accounts, commandLog, dailyPrices, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { REFRESH_MINUTES } from "@/lib/prices/config";
import { OWNER_PRICE_SOURCE } from "@/lib/prices/owner";
import { manualClasses } from "@/lib/prices/rebuilt";
import { defaultSources } from "@/lib/prices/refresh";
import { isConfirmed } from "@/lib/trades/confirmed";
import type { AssetClass, PriceSource } from "@/lib/prices/source";
import { execute } from "@/operations/runtime";

// Filling in past daily prices (#232), so trades (#247) can be valued on the
// days they were held. For each traded symbol, its closes from its first
// trade up to the earliest price already recorded (or yesterday), from its
// source's history: Tiingo for equities, Coinbase for crypto. One
// market.backfillPrices command per symbol.
//
// Bounded like refreshing: it runs from the same places (after a page that
// shows values, and the nightly sync), at most once per REFRESH_MINUTES,
// and only for symbols whose first trade is earlier than any price held.
// Requests carry the symbol and the dates, nothing else.

const yesterday = (now: Date) => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Each traded symbol's asset class and first trade date. */
export async function tradedSymbols(db: Db): Promise<{ assetClass: AssetClass; symbol: string; first: string }[]> {
  const [rows, classes] = await Promise.all([
    db
      .select({ accountId: trades.accountId, symbol: sql<string>`${trades.symbol}`, source: accounts.source, first: min(trades.on) })
      .from(trades)
      .innerJoin(accounts, eq(accounts.id, trades.accountId))
      // Confirmed only (#318), which always have a symbol.
      .where(isConfirmed)
      .groupBy(trades.accountId, trades.symbol, accounts.source),
    manualClasses(db),
  ]);
  const out = new Map<string, { assetClass: AssetClass; symbol: string; first: string }>();
  for (const r of rows) {
    const assetClass = r.source === "manual" ? (classes.get(`${r.accountId}:${r.symbol}`) ?? "crypto") : "equity";
    const key = `${assetClass}:${r.symbol}`;
    const prev = out.get(key);
    if (!prev || r.first! < prev.first) out.set(key, { assetClass, symbol: r.symbol, first: r.first! });
  }
  return [...out.values()];
}

export type BackfillOutcome = { status: "not due" | "nothing missing" } | { status: "backfilled"; symbols: number; added: number; failed: number };

export async function backfillPricesIfDue(db: Db, { now = new Date(), sources = defaultSources() }: { now?: Date; sources?: PriceSource[] } = {}): Promise<BackfillOutcome> {
  const [last] = await db
    .select({ at: commandLog.createdAt })
    .from(commandLog)
    .where(eq(commandLog.operation, "market.backfillPrices"))
    .orderBy(desc(commandLog.createdAt))
    .limit(1);
  if (last && now.getTime() - last.at.getTime() < REFRESH_MINUTES * 60_000) return { status: "not due" };

  const end = yesterday(now);
  let symbols = 0;
  let added = 0;
  let failed = 0;
  for (const { assetClass, symbol, first } of await tradedSymbols(db)) {
    const source = sources.find((s) => s.assetClass === assetClass && s.history);
    if (!source || first > end) continue;
    const [{ earliest }] = await db
      .select({ earliest: min(dailyPrices.on) })
      .from(dailyPrices)
      // The owner's own prices (#340) don't count: they stand in for a feed that had none.
      .where(and(eq(dailyPrices.assetClass, assetClass), eq(dailyPrices.symbol, symbol), ne(dailyPrices.source, OWNER_PRICE_SOURCE)));
    const to = earliest ? (dayBefore(earliest) < end ? dayBefore(earliest) : end) : end;
    if (first > to) continue;
    try {
      const closes = await source.history!(symbol, first, to);
      if (!closes?.length) continue;
      const result = await execute(db, {
        operation: "market.backfillPrices",
        actor: "market",
        reason: `Filled in past prices for ${symbol}`,
        input: { assetClass, source: source.id, symbol, closes },
      });
      if (result.status === "applied") added += (result.output as { added: number }).added;
      symbols++;
    } catch (error) {
      console.error(`Price history for a symbol failed: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
      failed++;
    }
  }
  return symbols || failed ? { status: "backfilled", symbols, added, failed } : { status: "nothing missing" };
}
