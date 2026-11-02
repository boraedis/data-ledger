import { and, eq, inArray, sql } from "drizzle-orm";
import { manualPositions, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { coinbaseSource } from "@/lib/prices/coinbase";
import { REFRESH_MINUTES } from "@/lib/prices/config";
import type { AssetClass, PriceSource } from "@/lib/prices/source";
import { execute } from "@/operations/runtime";

// Keeping market prices fresh (#229), at most once per REFRESH_MINUTES. The
// pages that show values ask for a refresh after they've been sent (Next's
// after()), and the nightly sync asks once; whichever comes first in an
// hour refreshes, and the rest find nothing due and write nothing.
//
// What gets priced: the symbols of positions entered by hand (#231), as
// crypto. A synced brokerage's equities will join once an equity source is
// chosen; until then they have none, and nothing is asked about them.

export const defaultSources = (): PriceSource[] => [coinbaseSource()];

/** The symbols to price, by asset class. */
export async function pricedSymbols(db: Db): Promise<Map<AssetClass, string[]>> {
  const rows = await db.selectDistinct({ symbol: sql<string>`upper(${manualPositions.symbol})` }).from(manualPositions);
  return new Map<AssetClass, string[]>([["crypto", rows.map((r) => r.symbol).sort()]]);
}

export type RefreshOutcome = { status: "fresh" } | { status: "refreshed"; commandId: string; priced: number; unpriced: number; failed: number };

/**
 * Refreshes every priced symbol not asked about within REFRESH_MINUTES, as
 * one market.refreshQuotes command. Nothing due: no request and no command.
 * Network requests happen here, before the write, so none is made while a
 * transaction is open.
 */
export async function refreshPricesIfDue(db: Db, { now = new Date(), sources = defaultSources() }: { now?: Date; sources?: PriceSource[] } = {}): Promise<RefreshOutcome> {
  const wanted = await pricedSymbols(db);
  const due = new Date(now.getTime() - REFRESH_MINUTES * 60_000);
  const batches = [];
  for (const source of sources) {
    const symbols = wanted.get(source.assetClass) ?? [];
    if (!symbols.length) continue;
    const checked = await db
      .select({ symbol: quotes.symbol, checkedAt: quotes.checkedAt })
      .from(quotes)
      .where(and(eq(quotes.assetClass, source.assetClass), inArray(quotes.symbol, symbols)));
    const recent = new Set(checked.filter((q) => q.checkedAt > due).map((q) => q.symbol));
    const stale = symbols.filter((s) => !recent.has(s));
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
