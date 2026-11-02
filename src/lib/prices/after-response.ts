import { after } from "next/server";
import { withTransactionalDb } from "@/lib/db";
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
      await withTransactionalDb((db) => refreshPricesIfDue(db));
    } catch (error) {
      console.error("Price refresh failed:", error instanceof Error ? error.message.slice(0, 120) : "unknown");
    }
  });
}
