import type { Grouping, Row } from "@/lib/spending/analyze";

// The Spending donut (#266): where the period's money went as shares of a
// whole, two rings deep. Client-safe and pure.
//   - Category: top-level categories inside, their subcategories outside.
//   - Account: the kind of account inside (checking, credit card...), the
//     accounts outside. Names only, never numbers or balances.
//   - Merchant: one ring of the biggest merchants.
// From the table's own rows, so the rings add up to the page's total. A
// slice is an angle, so only what was spent can be one: a row that refunds
// took below zero isn't drawn and is said so (`negative`), and an outer
// ring is fitted to its inner slice when a subcategory nets negative.
// Slices too small to read are merged into "Other"; the modal's table
// lists every row.

/** A slice under this share of the whole is merged into Other. */
export const MIN_SHARE = 0.02;
/** The merchant ring's most slices, before the rest are Other. */
export const MAX_MERCHANTS = 10;

export type Slice = {
  key: string;
  label: string;
  cents: number;
  /** For an outer slice, its inner one; and its share of that. */
  parent: { key: string; label: string; cents: number } | null;
  /** Where the slice starts and ends, as shares of the circle (0–1). */
  from: number;
  to: number;
  /** Which inner slice (or merchant) it is, for its colour. */
  index: number;
};

export type DonutRow = { key: string; label: string; cents: number; children: { key: string; label: string; cents: number }[] };

export type Donut = { inner: Slice[]; outer: Slice[] | null; totalCents: number; negative: { label: string; cents: number }[]; rows: DonutRow[] };

const OTHER = "__other";

/** Rows as the donut groups them: category rows as they are, accounts by kind, merchants flat. */
export function donutRows(rows: Row[], by: Grouping, accountKind: (accountId: string) => string): DonutRow[] {
  if (by === "account") {
    const kinds = new Map<string, DonutRow>();
    for (const r of rows) {
      const kind = accountKind(r.key);
      const k = kinds.get(kind) ?? { key: `kind:${kind}`, label: kind, cents: 0, children: [] };
      k.cents += r.spentCents;
      k.children.push({ key: r.key, label: r.label, cents: r.spentCents });
      kinds.set(kind, k);
    }
    return [...kinds.values()].sort((a, b) => b.cents - a.cents).map((k) => ({ ...k, children: k.children.sort((a, b) => b.cents - a.cents) }));
  }
  if (by === "merchant") return rows.map((r) => ({ key: r.key, label: r.label, cents: r.spentCents, children: [] }));
  // A category with no subcategories in play is its own outer slice.
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    cents: r.spentCents,
    children: r.children.length ? r.children.map((c) => ({ key: c.key, label: c.label, cents: c.spentCents })) : [{ key: r.key, label: r.label, cents: r.spentCents }],
  }));
}

/** Small ones merged into one "Other" at the end, never an Other of one. */
function merge<T extends { key: string; label: string; cents: number }>(items: T[], small: (t: T, i: number) => boolean, other: (cents: number) => T): T[] {
  const kept = items.filter((t, i) => !small(t, i));
  const rest = items.filter((t, i) => small(t, i));
  if (rest.length < 2) return items;
  return [...kept, other(rest.reduce((s, t) => s + t.cents, 0))];
}

export function donut(rows: DonutRow[], by: Grouping): Donut {
  const drawn = rows.filter((r) => r.cents > 0);
  const negative = rows.filter((r) => r.cents < 0).map((r) => ({ label: r.label, cents: r.cents }));
  const totalCents = drawn.reduce((s, r) => s + r.cents, 0);
  if (totalCents <= 0) return { inner: [], outer: null, totalCents: 0, negative, rows };

  const tooSmall = (cents: number) => cents / totalCents < MIN_SHARE;
  const innerItems = merge(
    drawn,
    (r, i) => tooSmall(r.cents) || (by === "merchant" && i >= MAX_MERCHANTS),
    (cents) => ({ key: OTHER, label: "Other", cents, children: [] }),
  );
  let at = 0;
  const inner: Slice[] = innerItems.map((r, index) => {
    const from = at;
    at += r.cents / totalCents;
    return { key: r.key, label: r.label, cents: r.cents, parent: null, from, to: at, index };
  });
  if (by === "merchant") return { inner, outer: null, totalCents, negative, rows };

  const outer: Slice[] = [];
  for (const slice of inner) {
    const row = drawn.find((r) => r.key === slice.key);
    const parent = { key: slice.key, label: slice.label, cents: slice.cents };
    // The merged Other has no breakdown of its own: one outer slice over it.
    const children = row ? row.children.filter((c) => c.cents > 0) : [{ key: OTHER, label: "Other", cents: slice.cents }];
    const parts = merge(
      children,
      (c) => tooSmall(c.cents),
      (cents) => ({ key: `${slice.key}${OTHER}`, label: `Other in ${slice.label}`, cents }),
    );
    // Fitted to the inner slice, in case a refund took a subcategory below zero.
    const sum = parts.reduce((s, c) => s + c.cents, 0) || 1;
    let pos = slice.from;
    for (const c of parts) {
      const from = pos;
      pos += ((slice.to - slice.from) * c.cents) / sum;
      outer.push({ key: c.key, label: c.label, cents: c.cents, parent, from, to: pos, index: slice.index });
    }
  }
  return { inner, outer, totalCents, negative, rows };
}
