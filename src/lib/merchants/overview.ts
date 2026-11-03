// The Merchants page (#286): each merchant's figures, from its linked
// transactions and the spending lines Spending and Budgets count, so the
// totals agree with those pages. Client-safe and pure.
//
// - Spent: net spend in expense categories (refunds offset it), from the
//   lines; gross when the page asks for it.
// - Transactions: every transaction linked to it, spending or not (a
//   refund, a paycheck from an employer).
// - Usual category: the category most of its transactions are filed under,
//   counting each transaction once per category it has (a split, each part).
// - Recurs: one of its names has a recurring series that isn't dismissed.

export type MerchantInfo = { id: string; name: string; typeId: string | null; type: string | null; aliases: string[] };
export type LinkedTxn = { id: string; merchantId: string; postedOn: string };
export type Line = { transactionId: string; date: string; amountCents: number; categoryId: string };

export type OverviewRow = {
  id: string;
  name: string;
  typeId: string | null;
  type: string | null;
  aliases: string[];
  spentCents: number;
  transactions: number;
  lastSeen: string | null;
  usualCategory: { id: string; name: string } | null;
  recurs: boolean;
};

export function merchantOverview(input: {
  merchants: MerchantInfo[];
  txns: LinkedTxn[];
  lines: Line[];
  category: (id: string) => { name: string; kind: string } | undefined;
  recurring: Set<string>;
}): OverviewRow[] {
  const merchantOf = new Map(input.txns.map((t) => [t.id, t.merchantId]));
  const stats = new Map<string, { spent: number; n: number; last: string | null; cats: Map<string, Set<string>> }>();
  const of = (id: string) => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { spent: 0, n: 0, last: null, cats: new Map() }));
    return s;
  };
  for (const t of input.txns) {
    const s = of(t.merchantId);
    s.n++;
    if (!s.last || t.postedOn > s.last) s.last = t.postedOn;
  }
  for (const l of input.lines) {
    const id = merchantOf.get(l.transactionId);
    if (!id) continue;
    const s = of(id);
    if (input.category(l.categoryId)?.kind === "expense") s.spent -= l.amountCents;
    const seen = s.cats.get(l.categoryId) ?? new Set<string>();
    seen.add(l.transactionId);
    s.cats.set(l.categoryId, seen);
  }
  return input.merchants.map((m) => {
    const s = stats.get(m.id);
    const usual = s ? [...s.cats.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0] : undefined;
    const name = usual ? input.category(usual[0])?.name : undefined;
    return {
      ...m,
      spentCents: s?.spent ?? 0,
      transactions: s?.n ?? 0,
      lastSeen: s?.last ?? null,
      usualCategory: usual && name ? { id: usual[0], name } : null,
      recurs: m.aliases.some((a) => input.recurring.has(a)),
    };
  });
}

export const SORTS = ["spent", "transactions", "last", "name"] as const;
export type Sort = (typeof SORTS)[number];

/** Search (name or any alias), a type filter (a type's id, "none" for no type) and a sort; biggest first except by name. */
export function filterMerchants(rows: OverviewRow[], { q, type, sort }: { q: string; type: string | null; sort: Sort }): OverviewRow[] {
  const needle = q.trim().toLowerCase();
  const kept = rows.filter(
    (r) =>
      (!needle || r.name.toLowerCase().includes(needle) || r.aliases.some((a) => a.toLowerCase().includes(needle))) &&
      (type === null || (type === "none" ? r.typeId === null : r.typeId === type)),
  );
  const by: Record<Sort, (a: OverviewRow, b: OverviewRow) => number> = {
    spent: (a, b) => b.spentCents - a.spentCents,
    transactions: (a, b) => b.transactions - a.transactions,
    last: (a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""),
    name: () => 0,
  };
  return kept.sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name));
}

/** A merchant's spending by month, for the months given ("YYYY-MM"), from its lines in expense categories. */
export function spendByMonth(lines: Line[], months: string[], isSpend: (categoryId: string) => boolean): { month: string; spentCents: number }[] {
  const by = new Map(months.map((m) => [m, 0]));
  for (const l of lines) {
    const m = l.date.slice(0, 7);
    if (by.has(m) && isSpend(l.categoryId)) by.set(m, by.get(m)! - l.amountCents);
  }
  return months.map((month) => ({ month, spentCents: by.get(month)! }));
}
