const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents → "$1,234.56". Formatting is the only place cents become a decimal. */
export function formatCents(cents: number, currency = "USD"): string {
  const formatter =
    currency === "USD" ? usd : new Intl.NumberFormat("en-US", { style: "currency", currency });
  return formatter.format(cents / 100);
}

/**
 * "-12.34" → -1234. Done on the string, never through a float: 0.1 + 0.2
 * style error has no business in a ledger. More than two decimals (some
 * institutions send them) rounds half away from zero.
 */
export function parseAmountCents(amount: string): number {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Unparseable amount "${amount}"`);
  const [, sign, whole, fraction = ""] = match;
  const padded = fraction.padEnd(3, "0");
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return sign === "-" && cents !== 0 ? -cents : cents;
}
