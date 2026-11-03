import { isNetOnly } from "@/lib/cashflow/pay-periods";
import type { PayLineGroup } from "@/lib/pay/stubs";

// The Pay page's chart (#272): one point per paycheck, net and gross with
// what came off in between, against a typical net. Client-safe and pure.
//
// - Paychecks are as Cash flow's pay periods count them
//   (lib/cashflow/pay-periods.ts): regular stubs on the same pay date (two
//   employers) are one paycheck. One-time stubs (a bonus) and net-only
//   stubs (only the net entered) are points of their own, marked, and never
//   averaged into the typical.
// - Typical net is the average of the three regular paychecks before, and
//   only once there are three, as Cash flow's monthly typical needs all
//   three months: an average of one isn't typical.
// - What came off is the stub's lines in the page's groups, which add up to
//   gross less net (a stub that doesn't can't be saved). Employer-paid
//   items are in neither gross nor net and stay off the chart, as on the page.

export const TYPICAL_PAYCHECKS = 3;
export const PAY_GROUPS: PayLineGroup[] = ["tax", "insurance", "retirement", "other"];

export type PayStubForChart = {
  payDate: string;
  employer: string;
  grossCents: number;
  netCents: number;
  oneTime: boolean;
  lines: unknown[];
  totals: Record<PayLineGroup, number>;
};

export type PayPoint = {
  payDate: string;
  employers: string[];
  kind: "regular" | "oneTime" | "netOnly";
  grossCents: number;
  netCents: number;
  groups: Record<PayLineGroup, number>;
  /** The three regular paychecks before, averaged; null before there are three. */
  typicalNetCents: number | null;
};

const kindOf = (s: PayStubForChart): PayPoint["kind"] => (s.oneTime ? "oneTime" : isNetOnly(s) ? "netOnly" : "regular");

/** Every paycheck, oldest first. */
export function payPoints(stubs: PayStubForChart[]): PayPoint[] {
  const byKey = new Map<string, PayPoint>();
  for (const s of [...stubs].sort((a, b) => a.payDate.localeCompare(b.payDate))) {
    const kind = kindOf(s);
    // Regular stubs on one day are one paycheck; a bonus or a net-only stub stays its own point.
    const key = kind === "regular" ? `${s.payDate} regular` : `${s.payDate} ${kind} ${byKey.size}`;
    const p = byKey.get(key) ?? { payDate: s.payDate, employers: [], kind, grossCents: 0, netCents: 0, groups: { tax: 0, insurance: 0, retirement: 0, other: 0 }, typicalNetCents: null };
    if (!p.employers.includes(s.employer)) p.employers.push(s.employer);
    p.grossCents += s.grossCents;
    p.netCents += s.netCents;
    for (const g of PAY_GROUPS) p.groups[g] += s.totals[g];
    byKey.set(key, p);
  }
  const points = [...byKey.values()];
  const regular: number[] = [];
  for (const p of points) {
    const before = regular.slice(-TYPICAL_PAYCHECKS);
    p.typicalNetCents = before.length === TYPICAL_PAYCHECKS ? Math.round(before.reduce((s, n) => s + n, 0) / TYPICAL_PAYCHECKS) : null;
    if (p.kind === "regular") regular.push(p.netCents);
  }
  return points;
}

/** Whether there's enough for a chart: three regular paychecks. */
export const enoughForChart = (points: PayPoint[]) => points.filter((p) => p.kind === "regular").length >= TYPICAL_PAYCHECKS;

export type PayRange = "year" | "12" | "all";

/** The first pay date a range shows. */
export function rangeStart(range: PayRange, today: string): string {
  if (range === "year") return `${today.slice(0, 4)}-01-01`;
  if (range === "12") return `${Number(today.slice(0, 4)) - 1}${today.slice(4, 10)}`;
  return "0000-01-01";
}

