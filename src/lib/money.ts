import { privacyOn } from "@/lib/privacy/state";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** What an amount shows as in privacy mode (#364): no digits, no length. */
export const MASKED_AMOUNT = "$•••";

/**
 * Integer cents → "$1,234.56", or `$•••` while privacy mode is on (#364):
 * every figure on screen comes through here, so masking it here masks it
 * everywhere. lib/privacy/state.ts says when it's on. Text that isn't for
 * a screen (to the model, a notification, a log) is formatted outside a
 * render, where it's always plain.
 */
export function formatCents(cents: number, currency = "USD"): string {
  if (privacyOn()) return MASKED_AMOUNT;
  return formatCentsPlain(cents, currency);
}

/** Integer cents → "$1,234.56", always. Formatting is the only place cents become a decimal. */
export function formatCentsPlain(cents: number, currency = "USD"): string {
  const formatter =
    currency === "USD" ? usd : new Intl.NumberFormat("en-US", { style: "currency", currency });
  // `|| 0` turns -0 (spending of nothing, negated) into 0: Intl would
  // print "-$0.00".
  return formatter.format((cents || 0) / 100);
}

/**
 * A dollar figure built by hand ("$1.2k" on a chart axis, a share's price),
 * or `$•••` while privacy mode is on. Everything that writes a "$" itself
 * goes through here, so nothing on screen skips the mask; a test holds the
 * app to it.
 */
export function dollarFigure(text: string): string {
  return privacyOn() ? MASKED_AMOUNT : text;
}

// A dollar figure inside free text: "$42.50", "-$1,200", "$1.2k", "+$3".
// Commas only between groups of three, so "$3," ends at the 3.
const MONEY_IN_TEXT = /[+\-−]?\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[kKMB]?/g;

/** Free text with amounts in it, masked, whatever the mode. */
export const maskMoneyText = (text: string) => text.replace(MONEY_IN_TEXT, MASKED_AMOUNT);

/**
 * Free text written earlier with amounts in it (an Activity reason, an
 * alert), as it shows now: masked while privacy mode is on.
 */
export function moneyText<T extends string | null | undefined>(text: T): T {
  return (text && privacyOn() ? maskMoneyText(text) : text) as T;
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
