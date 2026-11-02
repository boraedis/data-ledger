import type { PriceSource, QuoteResult } from "@/lib/prices/source";

// Equity and mutual fund prices from Tiingo (#229), on its free plan, which
// is for the owner's personal use only: the data is never shown or passed to
// anyone else. 50 requests an hour, 1,000 a day and 500 symbols a month,
// plenty for an hourly refresh of one person's holdings.
//
// Two endpoints, tried in order for each symbol:
//   1. IEX (/iex/<ticker>): an intraday price for listed stocks and ETFs.
//      The free plan gets `tngoLast`, Tiingo's own last price; the
//      exchange's `last` needs an entitlement and comes back null.
//   2. End of day (/tiingo/daily/<ticker>/prices): the latest close, and
//      the only price a mutual fund has (its NAV, after midnight ET). Marked
//      daily, so it reads as current for a day, not an hour.
// The key goes in the Authorization header, never the URL, so it can't end
// up in a log. Each request names one ticker and nothing else.

const BASE = "https://api.tiingo.com";

export const tiingoIexUrl = (symbol: string) => `${BASE}/iex/${encodeURIComponent(symbol.toLowerCase())}`;
export const tiingoDailyUrl = (symbol: string) => `${BASE}/tiingo/daily/${encodeURIComponent(symbol.toLowerCase())}/prices`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A JSON number as an exact decimal string, or null if it isn't a positive price. */
function decimal(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const text = String(value);
  // A tiny price prints as 1e-7; write it out instead.
  return /e/i.test(text) ? value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : text;
}

export function tiingoSource(key: string, fetchImpl: Fetch = fetch): PriceSource {
  const get = async (url: string) => {
    const response = await fetchImpl(url, {
      headers: { authorization: `Token ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  };

  return {
    id: "tiingo",
    assetClass: "equity",
    async quote(symbols) {
      const results: QuoteResult[] = [];
      for (const symbol of symbols) {
        try {
          const iex = (await get(tiingoIexUrl(symbol))) as { tngoLast?: unknown; timestamp?: unknown }[] | null;
          const live = Array.isArray(iex) ? iex[0] : undefined;
          const livePrice = decimal(live?.tngoLast);
          if (live && livePrice && typeof live.timestamp === "string") {
            results.push({ symbol, price: livePrice, asOf: new Date(live.timestamp) });
            continue;
          }
          // Not on IEX (a mutual fund, say): the latest daily price.
          const daily = (await get(tiingoDailyUrl(symbol))) as { close?: unknown; date?: unknown }[] | null;
          const close = Array.isArray(daily) ? daily.at(-1) : undefined;
          const closePrice = decimal(close?.close);
          if (close && closePrice && typeof close.date === "string") {
            results.push({ symbol, price: closePrice, asOf: new Date(close.date), daily: true });
          } else {
            results.push({ symbol, price: null });
          }
        } catch (error) {
          // The status or a short reason, never a body or the key.
          console.error(`Tiingo price for a symbol failed: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
          results.push({ symbol, failed: true });
        }
      }
      return results;
    },
  };
}
