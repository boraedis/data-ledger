// Where market prices come from (#229), one source per asset class, behind
// one interface the way bank data sits behind the Connector interface: a
// provider can change without anything downstream knowing. Crypto comes
// from Coinbase (./coinbase.ts). Equities have no source yet, until a
// provider is chosen; their symbols simply have no price.
//
// The rule every source keeps: a request carries a symbol and nothing else.
// Never a quantity, a cost, an account or anything that says how much the
// owner holds. Tests assert the URLs.

export type AssetClass = "crypto" | "equity";

export type QuoteResult =
  // The provider's price, an exact decimal in USD, and when it's from.
  | { symbol: string; price: string; asOf: Date }
  // The provider answered that it has no such symbol.
  | { symbol: string; price: null }
  // The provider couldn't be reached or answered oddly: try again next time.
  | { symbol: string; failed: true };

export type PriceSource = {
  /** Stored with each quote, so a price says where it's from. */
  id: string;
  assetClass: AssetClass;
  quote(symbols: string[]): Promise<QuoteResult[]>;
};
