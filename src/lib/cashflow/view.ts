// The Cash flow page's tabs and periods (#170): Annual (the default),
// Monthly and Pay periods (#175, which replaced Weekly), each with its own
// period, and the period carried across when switching tabs, so March's
// Monthly opens 2026's Annual. Pay periods are listed by year. Client-safe
// and pure.
//
// URL: ?view=monthly|pay (annual is the default and left out), with
// ?year=YYYY or ?month=YYYY-MM. A link from before the tabs (?month= or
// ?year= alone) opens the tab it implies; one to the old Weekly tab
// (?week=) opens that week's month.

export type CashFlowView = "annual" | "monthly" | "pay";
export const VIEWS: { id: CashFlowView; label: string }[] = [
  { id: "annual", label: "Annual" },
  { id: "monthly", label: "Monthly" },
  { id: "pay", label: "Pay periods" },
];

export type ViewPeriod = { view: CashFlowView; from: string; to: string; label: string; key: string };

const lastOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

/** A view's period from its key: a year (Annual, Pay periods) or a month. */
export function periodFor(view: CashFlowView, key: string): ViewPeriod {
  if (view === "monthly") return { view, key, from: `${key}-01`, to: lastOfMonth(key), label: fmt(`${key}-01`, { month: "long", year: "numeric" }) };
  return { view, key, from: `${key}-01-01`, to: `${key}-12-31`, label: key };
}

/** The tab and period a page's search params ask for; never later than today's. */
export function parseView(sp: Record<string, string | string[] | undefined>, today: string): ViewPeriod {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const asked = one(sp.view);
  const year = one(sp.year);
  const week = one(sp.week);
  // The old Weekly tab's links open the week's month.
  const month = one(sp.month) ?? (week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week.slice(0, 7) : undefined);
  const view: CashFlowView = asked === "monthly" || asked === "pay" || asked === "annual" ? asked : month ? "monthly" : "annual";
  if (view === "monthly") {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
    return periodFor(view, m > today.slice(0, 7) ? today.slice(0, 7) : m);
  }
  const y = year && /^\d{4}$/.test(year) ? year : month && /^\d{4}-\d{2}$/.test(month) ? month.slice(0, 4) : today.slice(0, 4);
  return periodFor(view, y > today.slice(0, 4) ? today.slice(0, 4) : y);
}

/**
 * The same period in another tab: the year a month falls in (Annual, Pay
 * periods); the month of a year (today's, if it's this year, else January).
 */
export function switchTo(p: ViewPeriod, view: CashFlowView, today: string): ViewPeriod {
  if (view === p.view) return p;
  if (view !== "monthly") return periodFor(view, p.from.slice(0, 4));
  const holdsToday = p.from <= today && today <= p.to;
  return periodFor(view, holdsToday ? today.slice(0, 7) : p.from.slice(0, 7));
}

/** The period before or after, in the same tab; null after when that's in the future. */
export function step(p: ViewPeriod, by: -1 | 1, today: string): ViewPeriod | null {
  const next = periodFor(p.view, p.view === "monthly" ? shiftMonth(p.key, by) : String(Number(p.key) + by));
  return by === 1 && next.from > today ? null : next;
}

/** The query for a period: the tab when it isn't Annual, and its key. */
export function viewQuery(p: ViewPeriod): Record<string, string> {
  if (p.view === "monthly") return { view: p.view, month: p.key };
  return p.view === "pay" ? { view: p.view, year: p.key } : { year: p.key };
}

/**
 * What a Monthly period is compared with (#172): the month before, or, for
 * the month in progress, the same days of it (the 1st to today's date,
 * clipped to its length), so a half month isn't held against a whole one.
 */
export function comparedWith(p: ViewPeriod, today: string): { from: string; to: string; label: string } {
  const month = shiftMonth(p.key, -1);
  const from = `${month}-01`;
  const end = lastOfMonth(month);
  const name = fmt(from, { month: "long" });
  if (!(p.from <= today && today <= p.to)) return { from, to: end, label: name };
  const day = `${month}-${today.slice(8, 10)}`;
  const to = day < end ? day : end;
  // Late in a long month, the same days can be all of a shorter one.
  return { from, to, label: to === end ? name : `${name} 1–${Number(to.slice(8, 10))}` };
}
