import type { PriceSource, QuoteResult } from "@/lib/prices/source";

// Crypto spot prices from Coinbase's public endpoint (#229): no key, one
// request per pair, in USD. The answer was the same with and without a
// CB-VERSION header when checked (2026-11-02), so none is sent. An unknown
// pair is a 404, which means "no price", not a failure.

const BASE = "https://api.coinbase.com/v2/prices";

/** The request URL for a symbol: the pair name and nothing else. */
export const coinbaseUrl = (symbol: string) => `${BASE}/${encodeURIComponent(`${symbol.toUpperCase()}-USD`)}/spot`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function coinbaseSource(fetchImpl: Fetch = fetch, now: () => Date = () => new Date()): PriceSource {
  return {
    id: "coinbase",
    assetClass: "crypto",
    async quote(symbols) {
      const results: QuoteResult[] = [];
      // One at a time: a handful of symbols, and no reason to burst a free endpoint.
      for (const symbol of symbols) {
        try {
          const response = await fetchImpl(coinbaseUrl(symbol), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
          if (response.status === 404) {
            results.push({ symbol, price: null });
            continue;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { data?: { amount?: unknown } };
          const amount = body.data?.amount;
          if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) throw new Error("No amount in the answer");
          results.push({ symbol, price: amount, asOf: now() });
        } catch (error) {
          // The status or a short reason, never the body.
          console.error(`Coinbase price for a symbol failed: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
          results.push({ symbol, failed: true });
        }
      }
      return results;
    },
  };
}
