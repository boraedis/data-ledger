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

/**
 * A decimal string in canonical form, for quantities that aren't money
 * (share counts): "+550.0" → "550", "0.50" → "0.5", "-0.0" → "0". Never goes
 * through a float. Throws on anything that isn't a plain decimal.
 */
export function normalizeDecimal(value: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[2] && !match[3])) throw new Error(`Unparseable decimal "${value}"`);
  const [, sign, whole, fraction = ""] = match;
  const intPart = whole.replace(/^0+(?=\d)/, "") || "0";
  const fracPart = fraction.replace(/0+$/, "");
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return sign === "-" && /[1-9]/.test(body) ? `-${body}` : body;
}
