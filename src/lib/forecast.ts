import type { AccountKind } from "@/lib/account-kinds";

// A net worth forecast (#233): today's net worth carried forward on the
// owner's own assumptions. Arithmetic only, no model and no advice: a
// scenario, shown with its assumptions beside it. Nothing is stored; the
// assumptions live in the page's URL, so trying a different rate changes
// the curve and nothing else.
//
// Four groups grow on their own: cash (checking, savings, payment apps),
// investments (brokerage, retirement), other assets (a home, a car,
// hand-entered holdings) and debts. Each asset group compounds monthly at
// its annual rate; the monthly amount added goes into investments. Debts
// stay as they are: paying them down or running them up is the owner's
// story, not a rate.

export type ForecastGroup = "cash" | "investments" | "other";

export const GROUP_LABELS: Record<ForecastGroup, string> = { cash: "Cash", investments: "Investments", other: "Other assets" };

const GROUP_OF: Record<AccountKind, ForecastGroup | "debts"> = {
  checking: "cash",
  savings: "cash",
  payment_app: "cash",
  brokerage: "investments",
  retirement: "investments",
  other_asset: "other",
  credit: "debts",
  loan: "debts",
};

export type ForecastStart = Record<ForecastGroup | "debts", number>;

/** Today's value of each group, in cents, from accounts' net worth contributions (debts negative). */
export function forecastStart(accounts: { kind: AccountKind; contributionCents: number | null }[]): ForecastStart {
  const start: ForecastStart = { cash: 0, investments: 0, other: 0, debts: 0 };
  for (const a of accounts) start[GROUP_OF[a.kind]] += a.contributionCents ?? 0;
  return start;
}

export type ForecastAssumptions = {
  // Annual growth, in percent, per group: 5 is 5% a year. Can be negative.
  ratesPct: Record<ForecastGroup, number>;
  // Added to investments at the end of every month.
  monthlyCents: number;
  years: number;
};

export const DEFAULT_ASSUMPTIONS: ForecastAssumptions = { ratesPct: { cash: 0, investments: 0, other: 0 }, monthlyCents: 0, years: 10 };

const LIMITS = { rate: 50, monthlyCents: 1_000_000_00, years: 40 };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
function num(v: string | string[] | undefined, min: number, max: number, fallback: number): number {
  const n = Number(one(v)?.replace(/[$,\s%]/g, ""));
  return one(v)?.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** The assumptions from the page's URL: ?cash=, ?inv=, ?other= (annual %), ?add= (dollars a month), ?years=. Out of range is clamped; nonsense is the default. */
export function parseAssumptions(sp: Params): ForecastAssumptions {
  const d = DEFAULT_ASSUMPTIONS;
  return {
    ratesPct: {
      cash: num(sp.cash, -LIMITS.rate, LIMITS.rate, d.ratesPct.cash),
      investments: num(sp.inv, -LIMITS.rate, LIMITS.rate, d.ratesPct.investments),
      other: num(sp.other, -LIMITS.rate, LIMITS.rate, d.ratesPct.other),
    },
    monthlyCents: Math.round(num(sp.add, 0, LIMITS.monthlyCents / 100, d.monthlyCents / 100) * 100),
    years: Math.round(num(sp.years, 1, LIMITS.years, d.years)),
  };
}

export type ForecastPoint = { on: string; cents: number; groups: ForecastStart };

/** One point a month from `from` (YYYY-MM-DD) for `years` years, the first being today's values. */
export function forecast(start: ForecastStart, a: ForecastAssumptions, from: string): ForecastPoint[] {
  // The monthly rate that compounds to the annual one.
  const monthly = (pct: number) => Math.pow(1 + pct / 100, 1 / 12) - 1;
  const rates = { cash: monthly(a.ratesPct.cash), investments: monthly(a.ratesPct.investments), other: monthly(a.ratesPct.other) };
  const v = { ...start };
  const [y, m, d] = from.split("-").map(Number);
  const point = (i: number): ForecastPoint => {
    // Month by month from `from`; the 31st becomes the month's last day.
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    const on = new Date(Date.UTC(y, m - 1 + i, Math.min(d, last))).toISOString().slice(0, 10);
    const groups = { cash: Math.round(v.cash), investments: Math.round(v.investments), other: Math.round(v.other), debts: Math.round(v.debts) };
    return { on, cents: groups.cash + groups.investments + groups.other + groups.debts, groups };
  };
  const points = [point(0)];
  for (let i = 1; i <= a.years * 12; i++) {
    v.cash *= 1 + rates.cash;
    v.investments = v.investments * (1 + rates.investments) + a.monthlyCents;
    v.other *= 1 + rates.other;
    points.push(point(i));
  }
  return points;
}
