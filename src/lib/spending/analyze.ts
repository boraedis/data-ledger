// Where the money went (#66): spending grouped by category, merchant or
// account over a period, each group against the period before. Pure: the
// page reads transactions.spendingLines (the same lines Budgets counts) and
// hands them here, so the two never disagree about what's spending.
//
// Spending is lines in expense categories, as a positive amount: refunds
// in an expense category offset it, income and transfer categories never
// count, and uncategorized transactions aren't lines at all (the page
// totals those separately so they aren't hidden).

export type SpendLine = { transactionId: string; date: string; amountCents: number; categoryId: string; accountId: string; merchant: string | null };
export type CategoryInfo = { id: string; name: string; kind: string; parentId: string | null };
export type Grouping = "category" | "merchant" | "account";

export type Row = { key: string; label: string; spentCents: number; prevCents: number; children: Row[] };

// --- Periods -------------------------------------------------------------------

export type PeriodParams = { month?: string; year?: string; from?: string; to?: string };
export type Range = { from: string; to: string; label: string };
export type Period = Range & {
  kind: "month" | "year" | "range";
  // The period it's compared with: the one before, over the same span. For
  // a period still under way, only as far into it as today, so a half-done
  // month isn't measured against a whole one.
  prev: Range;
  earlier: PeriodParams;
  later: PeriodParams | null;
};

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (on: string, n: number) => iso(new Date(Date.parse(on) + n * DAY_MS));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const monthStart = (y: number, m: number) => iso(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y: number, m: number) => iso(new Date(Date.UTC(y, m + 1, 0)));
const fmt = (on: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(`${on}T00:00:00Z`));
const shortRange = (from: string, to: string) => `${fmt(from, { month: "short", day: "numeric", year: "numeric" })} – ${fmt(to, { month: "short", day: "numeric", year: "numeric" })}`;

/** The same day-of-period in an earlier period, clamped to that period's end. */
function sameSpan(prevFrom: string, prevTo: string, from: string, to: string, today: string): string {
  if (today < from || today > to) return prevTo;
  const into = daysBetween(from, today);
  const candidate = addDays(prevFrom, into);
  return candidate < prevTo ? candidate : prevTo;
}

export function parsePeriod(params: PeriodParams, today: string): Period {
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];

  if (isDate(params.from) && isDate(params.to) && params.from <= params.to) {
    const { from, to } = params;
    const span = daysBetween(from, to) + 1;
    const prevFrom = addDays(from, -span);
    const prevTo = addDays(from, -1);
    const laterFrom = addDays(from, span);
    return {
      kind: "range",
      from,
      to,
      label: shortRange(from, to),
      prev: { from: prevFrom, to: prevTo, label: shortRange(prevFrom, prevTo) },
      earlier: { from: prevFrom, to: prevTo },
      later: laterFrom <= today ? { from: laterFrom, to: addDays(to, span) } : null,
    };
  }

  if (params.year && /^\d{4}$/.test(params.year)) {
    const y = Number(params.year);
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    const prevTo = sameSpan(`${y - 1}-01-01`, `${y - 1}-12-31`, from, to, today);
    const partial = prevTo !== `${y - 1}-12-31`;
    return {
      kind: "year",
      from,
      to,
      label: String(y),
      prev: { from: `${y - 1}-01-01`, to: prevTo, label: partial ? `${y - 1} to ${fmt(prevTo, { month: "short", day: "numeric" })}` : String(y - 1) },
      earlier: { year: String(y - 1) },
      later: y < ty ? { year: String(y + 1) } : null,
    };
  }

  const asked = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;
  const [y, m] = asked ? [Number(asked.slice(0, 4)), Number(asked.slice(5, 7)) - 1] : [ty, tm];
  const from = monthStart(y, m);
  const to = monthEnd(y, m);
  const prevFrom = monthStart(y, m - 1);
  const fullPrevTo = monthEnd(y, m - 1);
  const prevTo = sameSpan(prevFrom, fullPrevTo, from, to, today);
  const key = (yy: number, mm: number) => monthStart(yy, mm).slice(0, 7);
  return {
    kind: "month",
    from,
    to,
    label: fmt(from, { month: "long", year: "numeric" }),
    prev: {
      from: prevFrom,
      to: prevTo,
      label: prevTo === fullPrevTo ? fmt(prevFrom, { month: "long" }) : `${fmt(prevFrom, { month: "short" })} 1–${Number(prevTo.slice(8))}`,
    },
    earlier: { month: key(y, m - 1) },
    later: from < monthStart(ty, tm) ? { month: key(y, m + 1) } : null,
  };
}

// --- Grouping ------------------------------------------------------------------

export type Lookup = { categories: Map<string, CategoryInfo>; accountNames: Map<string, string> };

/** Spending lines only: expense categories. */
const isSpend = (line: SpendLine, lookup: Lookup) => lookup.categories.get(line.categoryId)?.kind === "expense";

// A parent's own spending, when it also has subcategories, is a row of its own.
const SELF = ":self";

function keysFor(line: SpendLine, by: Grouping, lookup: Lookup): { key: string; label: string; child?: { key: string; label: string } } {
  if (by === "merchant") return { key: line.merchant ?? "", label: line.merchant ?? "No merchant" };
  if (by === "account") return { key: line.accountId, label: lookup.accountNames.get(line.accountId) ?? "Unknown account" };
  const category = lookup.categories.get(line.categoryId)!;
  const parent = category.parentId ? lookup.categories.get(category.parentId) : undefined;
  if (!parent) return { key: category.id, label: category.name, child: { key: `${category.id}${SELF}`, label: `${category.name}, not in a subcategory` } };
  return { key: parent.id, label: parent.name, child: { key: category.id, label: category.name } };
}

export function spendingRows(lines: SpendLine[], prevLines: SpendLine[], by: Grouping, lookup: Lookup) {
  const rows = new Map<string, Row>();
  const add = (line: SpendLine, field: "spentCents" | "prevCents") => {
    if (!isSpend(line, lookup)) return;
    const k = keysFor(line, by, lookup);
    const row = rows.get(k.key) ?? { key: k.key, label: k.label, spentCents: 0, prevCents: 0, children: [] };
    row[field] -= line.amountCents;
    rows.set(k.key, row);
    if (k.child) {
      let child = row.children.find((c) => c.key === k.child!.key);
      if (!child) row.children.push((child = { ...k.child, spentCents: 0, prevCents: 0, children: [] }));
      child[field] -= line.amountCents;
    }
  };
  for (const line of lines) add(line, "spentCents");
  for (const line of prevLines) add(line, "prevCents");

  const rank = (a: Row, b: Row) => b.spentCents - a.spentCents || b.prevCents - a.prevCents || a.label.localeCompare(b.label);
  const result = [...rows.values()].sort(rank);
  for (const row of result) {
    // Only spending directly on a parent with no subcategories in play: no
    // breakdown to show.
    if (row.children.length === 1 && row.children[0].key.endsWith(SELF)) row.children = [];
    row.children.sort(rank);
  }
  return {
    rows: result,
    totalCents: result.reduce((s, r) => s + r.spentCents, 0),
    prevTotalCents: result.reduce((s, r) => s + r.prevCents, 0),
  };
}

/** Whether a line belongs to the row (or subcategory row) with this key. */
export function lineInRow(line: SpendLine, key: string, by: Grouping, lookup: Lookup): boolean {
  if (!isSpend(line, lookup)) return false;
  const k = keysFor(line, by, lookup);
  return k.key === key || k.child?.key === key;
}

/** One entry per transaction in a row, newest first: what was spent on it within the row. */
export function rowTransactions(lines: SpendLine[], key: string, by: Grouping, lookup: Lookup) {
  const byTxn = new Map<string, { transactionId: string; date: string; spentCents: number; accountId: string; merchant: string | null }>();
  for (const line of lines) {
    if (!lineInRow(line, key, by, lookup)) continue;
    const entry = byTxn.get(line.transactionId) ?? { transactionId: line.transactionId, date: line.date, spentCents: 0, accountId: line.accountId, merchant: line.merchant };
    entry.spentCents -= line.amountCents;
    byTxn.set(line.transactionId, entry);
  }
  return [...byTxn.values()].sort((a, b) => b.date.localeCompare(a.date) || b.spentCents - a.spentCents);
}

/** The row (or subcategory row) with this key, for its label. */
export function findRow(rows: Row[], key: string): Row | undefined {
  for (const row of rows) {
    if (row.key === key) return row;
    const child = row.children.find((c) => c.key === key);
    if (child) return child;
  }
  return undefined;
}
