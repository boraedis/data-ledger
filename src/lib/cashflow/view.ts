// The Cash flow page's tabs and periods (#170): Annual (the default),
// Monthly and Weekly, each with its own period, and the period carried
// across when switching tabs, so March's Monthly opens 2026's Annual, and
// a week opens its month. Client-safe and pure.
//
// URL: ?view=monthly|weekly (annual is the default and left out), with
// ?year=YYYY, ?month=YYYY-MM or ?week=YYYY-MM-DD (the Monday). A link from
// before the tabs (?month= or ?year= alone) opens the tab it implies.

import { weekStart } from "@/lib/cashflow/series";

export type CashFlowView = "annual" | "monthly" | "weekly";
export const VIEWS: { id: CashFlowView; label: string }[] = [
  { id: "annual", label: "Annual" },
  { id: "monthly", label: "Monthly" },
  { id: "weekly", label: "Weekly" },
];

export type ViewPeriod = { view: CashFlowView; from: string; to: string; label: string; key: string };

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const lastOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

/** A view's period from its key: a year, a month, or a week's Monday. */
export function periodFor(view: CashFlowView, key: string): ViewPeriod {
  if (view === "annual") return { view, key, from: `${key}-01-01`, to: `${key}-12-31`, label: key };
  if (view === "monthly") return { view, key, from: `${key}-01`, to: lastOfMonth(key), label: fmt(`${key}-01`, { month: "long", year: "numeric" }) };
  const to = addDays(key, 6);
  const sameYear = key.slice(0, 4) === to.slice(0, 4);
  return {
    view,
    key,
    from: key,
    to,
    label: `${fmt(key, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(to, { month: "short", day: "numeric", year: "numeric" })}`,
  };
}

/** The tab and period a page's search params ask for; never later than today's. */
export function parseView(sp: Record<string, string | string[] | undefined>, today: string): ViewPeriod {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const asked = one(sp.view);
  const year = one(sp.year);
  const month = one(sp.month);
  const week = one(sp.week);
  const view: CashFlowView =
    asked === "monthly" || asked === "weekly" || asked === "annual" ? asked : week ? "weekly" : month ? "monthly" : "annual";
  if (view === "annual") {
    const y = year && /^\d{4}$/.test(year) ? year : month && /^\d{4}-\d{2}$/.test(month) ? month.slice(0, 4) : today.slice(0, 4);
    return periodFor(view, y > today.slice(0, 4) ? today.slice(0, 4) : y);
  }
  if (view === "monthly") {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
    return periodFor(view, m > today.slice(0, 7) ? today.slice(0, 7) : m);
  }
  const w = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? weekStart(week) : weekStart(today);
  return periodFor(view, w > weekStart(today) ? weekStart(today) : w);
}

/**
 * The same period in another tab: the year a month or week falls in; the
 * month of a year (today's, if it's this year) or of a week; the week of a
 * month or year (today's, if the period holds today, else the first week
 * starting in it, so March doesn't open on a week that's mostly February).
 */
export function switchTo(p: ViewPeriod, view: CashFlowView, today: string): ViewPeriod {
  if (view === p.view) return p;
  const holdsToday = p.from <= today && today <= p.to;
  // A week straddling two months or years belongs where its Monday is.
  if (view === "annual") return periodFor(view, p.from.slice(0, 4));
  if (view === "monthly") return periodFor(view, holdsToday && p.view === "annual" ? today.slice(0, 7) : p.from.slice(0, 7));
  const monday = weekStart(p.from);
  return periodFor(view, holdsToday ? weekStart(today) : monday === p.from ? monday : addDays(monday, 7));
}

/** The period before or after, in the same tab; null after when that's in the future. */
export function step(p: ViewPeriod, by: -1 | 1, today: string): ViewPeriod | null {
  const key =
    p.view === "annual" ? String(Number(p.key) + by) : p.view === "monthly" ? shiftMonth(p.key, by) : addDays(p.key, 7 * by);
  const next = periodFor(p.view, key);
  return by === 1 && next.from > today ? null : next;
}

/** The query for a period: the tab when it isn't Annual, and its key. */
export function viewQuery(p: ViewPeriod): Record<string, string> {
  if (p.view === "annual") return { year: p.key };
  return { view: p.view, [p.view === "monthly" ? "month" : "week"]: p.key };
}
