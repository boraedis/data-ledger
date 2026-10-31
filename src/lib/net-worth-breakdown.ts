// Net worth broken down over time (#134): grouping each account's daily
// contribution by kind, account or institution, the time ranges, and the
// change over a range. Client-safe and pure; the daily values come from
// dailyContributions in src/lib/net-worth.ts.
//
// Grouping never changes the total: every account is in exactly one group
// (the smallest beyond the cap fold into "Other"), so a day's groups add up
// to that day's net worth whichever way it's sliced.

import { KIND_LABELS, type AccountKind } from "@/lib/account-kinds";

export type GroupBy = "kind" | "account" | "institution";
export type BreakdownAccount = { id: string; name: string; institution: string; kind: AccountKind };
export type Daily = { days: string[]; byAccount: Record<string, (number | null)[]> };
export type Group = { key: string; label: string; values: (number | null)[]; kind?: AccountKind };

// Past this many, the smallest groups fold into "Other": more hues than
// this can't be told apart in a stack.
export const MAX_GROUPS = 7;

const sumDay = (series: (number | null)[][], d: number) => {
  let any = false;
  let total = 0;
  for (const s of series) {
    if (s[d] !== null) {
      any = true;
      total += s[d]!;
    }
  }
  return any ? total : null;
};

/** The day-by-day total of a set of series: null where none had started. */
export function sumSeries(series: (number | null)[][], length: number): (number | null)[] {
  return Array.from({ length }, (_, d) => sumDay(series, d));
}

export function groupSeries(accounts: BreakdownAccount[], daily: Daily, groupBy: GroupBy): Group[] {
  const keyOf = (a: BreakdownAccount) => (groupBy === "kind" ? a.kind : groupBy === "account" ? a.id : a.institution);
  const labelOf = (a: BreakdownAccount) => (groupBy === "kind" ? KIND_LABELS[a.kind] : groupBy === "account" ? a.name : a.institution);
  const members = new Map<string, { label: string; kind?: AccountKind; series: (number | null)[][] }>();
  for (const a of accounts) {
    const series = daily.byAccount[a.id];
    if (!series) continue;
    const key = keyOf(a);
    const entry = members.get(key) ?? { label: labelOf(a), kind: groupBy === "kind" ? a.kind : undefined, series: [] };
    entry.series.push(series);
    members.set(key, entry);
  }
  const groups = [...members].map(([key, m]) => ({ key, label: m.label, kind: m.kind, values: sumSeries(m.series, daily.days.length) }));
  // Largest first by today's size, so the cap keeps what matters.
  const latest = (g: Group) => Math.abs(g.values.at(-1) ?? 0);
  groups.sort((a, b) => latest(b) - latest(a) || a.label.localeCompare(b.label));
  if (groups.length <= MAX_GROUPS + 1) return groups;
  const kept = groups.slice(0, MAX_GROUPS);
  const rest = groups.slice(MAX_GROUPS);
  return [...kept, { key: "other", label: `Other (${rest.length})`, values: sumSeries(rest.map((g) => g.values), daily.days.length) }];
}

export const RANGES = [
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "All" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

const shiftMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

/** The range's first day. "All" starts at the first day there's any history. */
export function rangeStart(range: RangeKey, lastDay: string, firstDay: string): string {
  if (range === "all") return firstDay;
  if (range === "ytd") return `${lastDay.slice(0, 4)}-01-01`;
  return shiftMonths(lastDay, range === "1m" ? -1 : range === "3m" ? -3 : -12);
}

/**
 * The change over a range: the last value less the value on the range's
 * first day, or on the first day after it with a value when history (or
 * this group) starts later; `since` says which day that was. Null with no
 * value in the range.
 */
export function changeOver(days: string[], values: (number | null)[], from: string) {
  const start = days.findIndex((d, i) => d >= from && values[i] !== null);
  if (start === -1) return null;
  const end = values.length - 1;
  const endCents = values[end] ?? 0;
  return { since: days[start], startCents: values[start]!, endCents, changeCents: endCents - values[start]! };
}
