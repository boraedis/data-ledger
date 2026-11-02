import { eq } from "drizzle-orm";
import { quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { STALE_MINUTES } from "@/lib/prices/config";
import type { AssetClass } from "@/lib/prices/source";

// Reading cached market prices (#229), apart from refreshing them
// (./refresh.ts), so what reads values (net worth, #230) doesn't pull in the
// operations runtime.

export type Quote = { price: string | null; asOf: Date | null; stale: boolean; source: string };

/** The latest quote per crypto symbol, for display: "no price" is a null price, and a stale one says so. */
export async function latestQuotes(db: Db, assetClass: AssetClass, { now = new Date() }: { now?: Date } = {}): Promise<Map<string, Quote>> {
  const rows = await db.select().from(quotes).where(eq(quotes.assetClass, assetClass));
  const staleBefore = now.getTime() - STALE_MINUTES * 60_000;
  return new Map(
    rows.map((q) => [q.symbol, { price: q.price, asOf: q.asOf, stale: q.asOf === null || q.asOf.getTime() < staleBefore, source: q.source }]),
  );
}
