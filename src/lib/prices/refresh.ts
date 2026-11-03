import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { accounts, holdingSnapshots, manualPositions, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { coinbaseSource } from "@/lib/prices/coinbase";
import { DAILY_REFRESH_MINUTES, REFRESH_MINUTES } from "@/lib/prices/config";
import { isDailySource } from "@/lib/prices/quotes";
import type { AssetClass, PriceSource } from "@/lib/prices/source";
import { tiingoSource } from "@/lib/prices/tiingo";
import { execute } from "@/operations/runtime";

// Keeping market prices fresh (#229), at most once per REFRESH_MINUTES. The
// pages that show values ask for a refresh after they've been sent (Next's
// after()), and the nightly sync asks once; whichever comes first in an
// hour refreshes, and the rest find nothing due and write nothing.
//
// What gets priced: the symbols of positions entered by hand (#231), each
// as the kind of asset the owner said it is (#244), and the symbols in each brokerage or retirement account's newest
// holdings snapshot, as equities (Tiingo, when TIINGO_API_KEY is set; without
// it, equities aren't asked about and keep their synced value).
//
// Equities are asked about hourly only while the US market is open. Outside
// it, and for once-a-day prices like a fund's NAV, there's nothing new for
// half a day, so they wait that long.

export const defaultSources = (): PriceSource[] => {
  const key = process.env.TIINGO_API_KEY;
  return [coinbaseSource(), ...(key ? [tiingoSource(key)] : [])];
};

/** The symbols to price, by asset class. */
export async function pricedSymbols(db: Db): Promise<Map<AssetClass, string[]>> {
  const [manual, latestDays] = await Promise.all([
    db.selectDistinct({ symbol: sql<string>`upper(${manualPositions.symbol})`, assetClass: manualPositions.assetClass }).from(manualPositions),
    db
      .select({ accountId: holdingSnapshots.accountId, on: sql<string>`max(${holdingSnapshots.on})` })
      .from(holdingSnapshots)
      .innerJoin(accounts, eq(accounts.id, holdingSnapshots.accountId))
      .where(inArray(accounts.type, [...INVESTMENT_KINDS]))
      .groupBy(holdingSnapshots.accountId),
  ]);
  const held = latestDays.length
    ? await db
        .selectDistinct({ symbol: sql<string>`upper(${holdingSnapshots.symbol})` })
        .from(holdingSnapshots)
        .where(
          and(
            isNotNull(holdingSnapshots.symbol),
            sql`(${holdingSnapshots.accountId}, ${holdingSnapshots.on}) in (${sql.join(
              latestDays.map((d) => sql`(${d.accountId}::uuid, ${d.on}::date)`),
              sql`, `,
            )})`,
          ),
        )
    : [];
  const of = (assetClass: AssetClass) => manual.filter((r) => r.assetClass === assetClass).map((r) => r.symbol);
  return new Map<AssetClass, string[]>([
    ["crypto", [...new Set(of("crypto"))].sort()],
    ["equity", [...new Set([...of("equity"), ...held.map((r) => r.symbol)])].sort()],
  ]);
}

const easternParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });

/** Whether the US stock market is in its regular session (9:30 to 16:00 ET, Monday to Friday). Holidays aren't known; a refresh then just finds the last close. */
export function usMarketOpen(now: Date): boolean {
  const parts = Object.fromEntries(easternParts.formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Whether a symbol last asked about at `checkedAt` (with a quote from `source`) should be asked again. */
function isDue(assetClass: AssetClass, quote: { checkedAt: Date; source: string } | undefined, now: Date): boolean {
  if (!quote) return true;
  const age = (now.getTime() - quote.checkedAt.getTime()) / 60_000;
  if (age < REFRESH_MINUTES) return false;
  if (assetClass === "crypto") return true;
  if (isDailySource(quote.source) || !usMarketOpen(now)) return age >= DAILY_REFRESH_MINUTES;
  return true;
}

export type RefreshOutcome = { status: "fresh" } | { status: "refreshed"; commandId: string; priced: number; unpriced: number; failed: number };

/**
 * Refreshes every priced symbol that's due (see isDue), as one
 * market.refreshQuotes command. Nothing due: no request and no command.
 * Network requests happen here, before the write, so none is made while a
 * transaction is open.
 */
export async function refreshPricesIfDue(db: Db, { now = new Date(), sources = defaultSources() }: { now?: Date; sources?: PriceSource[] } = {}): Promise<RefreshOutcome> {
  const wanted = await pricedSymbols(db);
  const batches = [];
  for (const source of sources) {
    const symbols = wanted.get(source.assetClass) ?? [];
    if (!symbols.length) continue;
    const checked = await db
      .select({ symbol: quotes.symbol, checkedAt: quotes.checkedAt, source: quotes.source })
      .from(quotes)
      .where(and(eq(quotes.assetClass, source.assetClass), inArray(quotes.symbol, symbols)));
    const bySymbol = new Map(checked.map((q) => [q.symbol, q]));
    const stale = symbols.filter((s) => isDue(source.assetClass, bySymbol.get(s), now));
    if (!stale.length) continue;
    const results = await source.quote(stale);
    batches.push({
      assetClass: source.assetClass,
      source: source.id,
      results: results.map((r) => ("price" in r && r.price !== null ? { ...r, asOf: r.asOf.toISOString() } : r)),
    });
  }
  if (!batches.length) return { status: "fresh" };
  const result = await execute(db, {
    operation: "market.refreshQuotes",
    actor: "market",
    reason: "Refreshed market prices",
    input: { at: now.toISOString(), batches },
  });
  if (result.status !== "applied") throw new Error("Price refresh wasn't applied");
  return { status: "refreshed", commandId: result.commandId, ...(result.output as { priced: number; unpriced: number; failed: number }) };
}
