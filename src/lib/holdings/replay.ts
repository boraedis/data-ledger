// Replaying trades (#247): how much of each symbol an account held on any
// day, from its dated buys, sells and share transfers. Exact, on the decimal
// strings with BigInt, never through a float, so a replay of today ends
// exactly where the positions are. Client-safe and pure.

export type TradeSide = "buy" | "sell" | "transfer_in" | "transfer_out";

export const SIDE_LABELS: Record<TradeSide, string> = { buy: "Buy", sell: "Sell", transfer_in: "Transfer in", transfer_out: "Transfer out" };

export type Trade = { on: string; symbol: string; side: TradeSide; quantity: string; createdAt?: Date };

/** A signed exact decimal: integer units at a scale (number of decimal places). */
type Dec = { units: bigint; scale: number };

const ZERO = BigInt(0);
const TEN = BigInt(10);

function parse(text: string): Dec {
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^[-+]/, "").split(".");
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  const lift = (d: Dec) => d.units * TEN ** BigInt(scale - d.scale);
  return { units: lift(a) + lift(b), scale };
}

function format(d: Dec): string {
  const negative = d.units < ZERO;
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, "0");
  const whole = digits.slice(0, digits.length - d.scale);
  const fraction = digits.slice(digits.length - d.scale).replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}

const signed = (t: Trade): Dec => {
  const q = parse(t.quantity);
  return t.side === "sell" || t.side === "transfer_out" ? { ...q, units: -q.units } : q;
};

/** Trades in the order they happened: by date, then as entered. */
export function inOrder<T extends Trade>(trades: T[]): T[] {
  return [...trades].sort((a, b) => a.on.localeCompare(b.on) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/** What was held of each symbol at the end of `day` (all of time when omitted), as exact decimal strings. Symbols at zero are left out. */
export function holdingsOn(trades: Trade[], day?: string): Map<string, string> {
  const totals = new Map<string, Dec>();
  for (const t of inOrder(trades)) {
    if (day && t.on > day) break;
    totals.set(t.symbol, add(totals.get(t.symbol) ?? { units: ZERO, scale: 0 }, signed(t)));
  }
  return new Map([...totals].filter(([, d]) => d.units !== ZERO).map(([symbol, d]) => [symbol, format(d)]));
}

/** The first point where a symbol's running quantity goes below zero, if any: selling more than was held. */
export function firstShortfall(trades: Trade[]): { symbol: string; on: string; quantity: string } | null {
  const totals = new Map<string, Dec>();
  for (const t of inOrder(trades)) {
    const next = add(totals.get(t.symbol) ?? { units: ZERO, scale: 0 }, signed(t));
    if (next.units < ZERO) return { symbol: t.symbol, on: t.on, quantity: format(next) };
    totals.set(t.symbol, next);
  }
  return null;
}

/** a − b, exactly. */
export function difference(a: string, b: string): string {
  const bd = parse(b);
  return format(add(parse(a), { ...bd, units: -bd.units }));
}
