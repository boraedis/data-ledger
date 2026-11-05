import { after } from "next/server";
import { withTransactionalDb } from "@/lib/db";
import { backfillPricesIfDue } from "@/lib/prices/backfill";
import { backfillHourlyIfDue } from "@/lib/prices/hourly";
import { refreshPricesIfDue } from "@/lib/prices/refresh";

/**
 * For a page that shows values (#229): once it's been sent, refresh prices
 * if they're due. The page shows what's cached now; the next load shows the
 * refresh. A failure is logged and changes nothing: prices just stay as
 * they were, labelled with their time.
 */
export function refreshPricesAfterResponse() {
  after(async () => {
    try {
      const refreshed = await withTransactionalDb((db) => refreshPricesIfDue(db));
      // And past prices for traded symbols (#232), when any are missing.
      await withTransactionalDb((db) => backfillPricesIfDue(db));
      // And held coins' hourly prices (#243), for the hourly net worth ranges
      // (#338): with each quote refresh, so at most once an interval, and a
      // stretch Coinbase has no candles for isn't asked about on every view.
      if (refreshed.status === "refreshed") await withTransactionalDb((db) => backfillHourlyIfDue(db));
    } catch (error) {
      console.error("Price refresh failed:", error instanceof Error ? error.message.slice(0, 120) : "unknown");
    }
  });
}
