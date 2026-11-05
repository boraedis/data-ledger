import type { PriceSource, QuoteResult } from "@/lib/prices/source";

// Crypto spot prices from Coinbase's public endpoint (#229): no key, one
// request per pair, in USD. The answer was the same with and without a
// CB-VERSION header when checked (2026-11-02), so none is sent. An unknown
// pair is a 404, which means "no price", not a failure.

const BASE = "https://api.coinbase.com/v2/prices";
// Daily candles come from Coinbase's public exchange API, also keyless: rows
// of [time, low, high, open, close, volume], newest first, at most 300 a
// request. An unknown pair is a 404 there too.
const CANDLES = "https://api.exchange.coinbase.com/products";
const CANDLES_PER_REQUEST = 300;

/** The candles URL for a pair and window: the pair name and dates, nothing else. */
export const coinbaseCandlesUrl = (symbol: string, from: string, to: string) =>
  `${CANDLES}/${encodeURIComponent(`${symbol.toUpperCase()}-USD`)}/candles?granularity=86400&start=${from}T00:00:00Z&end=${to}T00:00:00Z`;

/** The hourly candles URL for a pair and window (#243): the pair name and times, nothing else. */
export const coinbaseHourlyUrl = (symbol: string, from: Date, to: Date) =>
  `${CANDLES}/${encodeURIComponent(`${symbol.toUpperCase()}-USD`)}/candles?granularity=3600&start=${from.toISOString()}&end=${to.toISOString()}`;
const HOUR = 3_600_000;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const closeText = (n: number) => (/e/i.test(String(n)) ? n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : String(n));

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
    async history(symbol, from, to) {
      const closes: { on: string; price: string }[] = [];
      for (let start = from; start <= to; start = addDays(start, CANDLES_PER_REQUEST)) {
        const end = addDays(start, CANDLES_PER_REQUEST - 1) < to ? addDays(start, CANDLES_PER_REQUEST - 1) : to;
        const response = await fetchImpl(coinbaseCandlesUrl(symbol, start, end), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows = (await response.json()) as unknown;
        if (!Array.isArray(rows)) throw new Error("No candles in the answer");
        for (const row of rows) {
          if (!Array.isArray(row) || typeof row[0] !== "number" || typeof row[4] !== "number" || row[4] <= 0) continue;
          closes.push({ on: new Date(row[0] * 1000).toISOString().slice(0, 10), price: closeText(row[4]) });
        }
      }
      return closes.sort((a, b) => a.on.localeCompare(b.on));
    },
    async hourly(symbol, from, to) {
      const closes = new Map<string, string>();
      // 300 hours a request, oldest window first; one at a time, like the rest.
      for (let start = from.getTime(); start <= to.getTime(); start += CANDLES_PER_REQUEST * HOUR) {
        const end = Math.min(start + (CANDLES_PER_REQUEST - 1) * HOUR, to.getTime());
        const response = await fetchImpl(coinbaseHourlyUrl(symbol, new Date(start), new Date(end)), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows = (await response.json()) as unknown;
        if (!Array.isArray(rows)) throw new Error("No candles in the answer");
        for (const row of rows) {
          if (!Array.isArray(row) || typeof row[0] !== "number" || typeof row[4] !== "number" || row[4] <= 0) continue;
          closes.set(new Date(row[0] * 1000).toISOString(), closeText(row[4]));
        }
      }
      return [...closes].map(([hour, price]) => ({ hour, price })).sort((a, b) => a.hour.localeCompare(b.hour));
    },
  };
}
