// The source name for a price the owner entered (#340), in daily_prices next
// to the market feed's closes. History carries an owner's price forward to
// the next one, however far (a market close is carried only over a weekend
// or a holiday), and price backfill ignores it.
export const OWNER_PRICE_SOURCE = "owner";
