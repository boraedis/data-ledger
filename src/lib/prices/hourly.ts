import { and, eq, isNotNull, max, min } from "drizzle-orm";
import { intradayPrices, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { tradedSymbols } from "@/lib/prices/backfill";
import { defaultSources } from "@/lib/prices/refresh";
import type { PriceSource } from "@/lib/prices/source";
import { execute } from "@/operations/runtime";

// Keeping hourly crypto prices (#243) for the hourly ranges of the net worth
// chart (#338). For each coin that's held and that Coinbase prices: the
// window back to HOURLY_DAYS ago (or the coin's first trade, if later) the
// first time, then only the hours after the newest one stored. A coin
// Coinbase has no quote for isn't asked about, so an unknown coin isn't
// retried on every page view. Equities aren't here: Tiingo's hourly data was
// never confirmed on the free plan, so stocks keep their daily close.
//
// Requests carry the pair and the time window, nothing else.

/** How far back hourly prices go: the longest hourly range (3M), with slack. */
export const HOURLY_DAYS = 95;
const HOUR = 3_600_000;
const startOfHour = (t: number) => Math.floor(t / HOUR) * HOUR;

export type HourlyOutcome = { symbols: number; added: number; failed: number };

export async function backfillHourlyIfDue(db: Db, { now = new Date(), sources = defaultSources() }: { now?: Date; sources?: PriceSource[] } = {}): Promise<HourlyOutcome> {
  const source = sources.find((s) => s.assetClass === "crypto" && s.hourly);
  const out: HourlyOutcome = { symbols: 0, added: 0, failed: 0 };
  if (!source) return out;
  // The last complete hour; the current one's candle is still moving.
  const lastHour = startOfHour(now.getTime()) - HOUR;
  const windowStart = startOfHour(now.getTime() - HOURLY_DAYS * 86_400_000);
  const priced = new Set(
    (await db.select({ symbol: quotes.symbol }).from(quotes).where(and(eq(quotes.assetClass, "crypto"), isNotNull(quotes.price)))).map((q) => q.symbol.toUpperCase()),
  );

  for (const { assetClass, symbol, first } of await tradedSymbols(db)) {
    if (assetClass !== "crypto" || !priced.has(symbol)) continue;
    const from = Math.max(windowStart, startOfHour(Date.parse(`${first}T00:00:00Z`)));
    if (from > lastHour) continue;
    const [{ earliest, latest }] = await db
      .select({ earliest: min(intradayPrices.hour), latest: max(intradayPrices.hour) })
      .from(intradayPrices)
      .where(and(eq(intradayPrices.assetClass, "crypto"), eq(intradayPrices.symbol, symbol)));
    // What's missing: before the stored hours, and after them.
    const windows: [number, number][] = [];
    if (!earliest || !latest) windows.push([from, lastHour]);
    else {
      if (earliest.getTime() > from) windows.push([from, earliest.getTime() - HOUR]);
      if (latest.getTime() < lastHour) windows.push([latest.getTime() + HOUR, lastHour]);
    }
    if (!windows.length) continue;
    out.symbols++;
    try {
      const closes = (await Promise.all(windows.map(([a, b]) => source.hourly!(symbol, new Date(a), new Date(b))))).flatMap((c) => c ?? []);
      if (!closes.length) continue;
      const result = await execute(db, {
        operation: "market.storeHourly",
        actor: "market",
        reason: `Filled in hourly prices for ${symbol}`,
        input: { assetClass: "crypto", source: source.id, symbol, closes },
      });
      if (result.status === "applied") out.added += (result.output as { added: number }).added;
    } catch (error) {
      out.failed++;
      console.error(`Hourly prices for a symbol failed: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
    }
  }
  return out;
}
