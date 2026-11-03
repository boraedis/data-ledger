// Where market prices come from (#229), one source per asset class, behind
// one interface the way bank data sits behind the Connector interface: a
// provider can change without anything downstream knowing. Crypto comes
// from Coinbase (./coinbase.ts), equities and mutual funds from Tiingo
// (./tiingo.ts) once its key is set.
//
// The rule every source keeps: a request carries a symbol and nothing else.
// Never a quantity, a cost, an account or anything that says how much the
// owner holds. Tests assert the URLs.

export type AssetClass = "crypto" | "equity";

export type QuoteResult =
  // The provider's price, an exact decimal in USD, and when it's from.
  // `daily` marks a price set once a day, such as a mutual fund's NAV: it's
  // current for a day, not an hour, so it's neither stale nor due as soon.
  | { symbol: string; price: string; asOf: Date; daily?: boolean }
  // The provider answered that it has no such symbol.
  | { symbol: string; price: null }
  // The provider couldn't be reached or answered oddly: try again next time.
  | { symbol: string; failed: true };

/** A day's closing price, an exact decimal in USD. */
export type DailyClose = { on: string; price: string };

export type PriceSource = {
  /** Stored with each quote, so a price says where it's from. */
  id: string;
  assetClass: AssetClass;
  quote(symbols: string[]): Promise<QuoteResult[]>;
  /**
   * Daily closes from `from` to `to` (YYYY-MM-DD, both included), for
   * rebuilding history (#232): null when the provider has no such symbol,
   * and a throw when it couldn't be reached. Days without trading are
   * simply absent. Optional: a source without it isn't backfilled.
   */
  history?(symbol: string, from: string, to: string): Promise<DailyClose[] | null>;
};
