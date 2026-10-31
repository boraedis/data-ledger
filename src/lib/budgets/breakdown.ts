// A budget item's period, broken down (#174): by category (a parent's
// subcategories, or everything the buffer covers) and by merchant. Built
// from the same lines as the item's spent figure (budgets.targetTransactions),
// so each breakdown adds up to it exactly. Client-safe and pure.

type Line = { amountCents: number; categoryName: string; merchant: string | null; description: string };
export type Share = { name: string; spentCents: number; lines: number };

/** Spending as a positive amount; a refund counts against it. */
const spent = (l: Line) => -l.amountCents;

function group(lines: Line[], key: (l: Line) => string): Share[] {
  const byKey = new Map<string, Share>();
  for (const l of lines) {
    const name = key(l);
    const s = byKey.get(name) ?? { name, spentCents: 0, lines: 0 };
    s.spentCents += spent(l);
    s.lines += 1;
    byKey.set(name, s);
  }
  return [...byKey.values()].sort((a, b) => b.spentCents - a.spentCents || a.name.localeCompare(b.name));
}

export function periodBreakdown(lines: Line[]) {
  return {
    spentCents: lines.reduce((sum, l) => sum + spent(l), 0),
    byCategory: group(lines, (l) => l.categoryName),
    // The merchant where the aggregator named one, else the bank's description.
    byMerchant: group(lines, (l) => l.merchant ?? l.description),
  };
}
