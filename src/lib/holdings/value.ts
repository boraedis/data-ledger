// A hand-entered position's value (#231): quantity × unit price, in cents.
// Done on the decimal strings with BigInt, never through a float: a
// quantity like 0.00012345 times a five-figure price has to come out the
// same every time. Client-safe and pure.

/** A positive exact decimal as typed: "0.5", "12", "1,234.5678". Commas are allowed, nothing else. */
export const DECIMAL = /^\d+(\.\d+)?$/;

export function normalizeQuantity(text: string): string | null {
  const plain = text.trim().replace(/,/g, "");
  if (!DECIMAL.test(plain)) return null;
  // Canonical: no leading zeros, no trailing fractional zeros.
  const [whole, fraction = ""] = plain.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

function scaled(decimal: string): { units: bigint; scale: number } {
  const [whole, fraction = ""] = decimal.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** quantity × unitPrice in cents, rounded half up. Both are non-negative decimal strings. */
export function positionValueCents(quantity: string, unitPrice: string): number {
  const q = scaled(quantity);
  const p = scaled(unitPrice);
  // BigInt(...) rather than literals: the project targets ES2017.
  const [two, hundred] = [BigInt(2), BigInt(100)];
  const divisor = BigInt(10) ** BigInt(q.scale + p.scale);
  const hundredths = q.units * p.units * hundred;
  return Number((hundredths * two + divisor) / (divisor * two));
}
