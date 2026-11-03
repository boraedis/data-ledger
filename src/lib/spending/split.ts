import type { Row } from "@/lib/spending/analyze";

// The split chart's rows (#265): the grouping's biggest rows from the
// table, this period and the last, the rest summed into one line, on one
// scale. The table's own rows (top level for categories), so the amounts
// always match it. Client-safe and pure.

export const SPLIT_ROWS = 8;

export type Split = {
  shown: Row[];
  rest: { count: number; spentCents: number; prevCents: number } | null;
  /** The longest bar either period has, which every bar is measured against. */
  scaleCents: number;
};

export function splitRows(rows: Row[], limit = SPLIT_ROWS): Split {
  // One line for the rest only saves space when it stands for two or more.
  const cut = rows.length > limit + 1 ? limit : rows.length;
  const shown = rows.slice(0, cut);
  const others = rows.slice(cut);
  const rest = others.length
    ? { count: others.length, spentCents: others.reduce((s, r) => s + r.spentCents, 0), prevCents: others.reduce((s, r) => s + r.prevCents, 0) }
    : null;
  const amounts = [...shown, ...(rest ? [rest] : [])].flatMap((r) => [r.spentCents, r.prevCents]);
  return { shown, rest, scaleCents: Math.max(1, ...amounts) };
}

/** A bar's length as a share of the scale; a refund-heavy row below zero draws none. */
export const barShare = (cents: number, scaleCents: number) => Math.max(0, cents) / scaleCents;
