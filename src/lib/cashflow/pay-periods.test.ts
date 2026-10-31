import { describe, expect, it } from "vitest";
import { payPeriodRanges, payPeriods } from "./pay-periods";
import { flowDays, total } from "./series";

// Invented biweekly pay: $1,500 net every other Friday.
const stub = (payDate: string, extra: Partial<{ netCents: number; grossCents: number; oneTime: boolean; lines: unknown[] }> = {}) => ({
  payDate,
  employer: "Synthetic Employer",
  netCents: 150_000,
  grossCents: 200_000,
  oneTime: false,
  lines: [{}],
  ...extra,
});
const TODAY = "2026-09-30";
const stubs = [stub("2026-09-04"), stub("2026-09-18"), stub("2026-10-02")];

describe("pay periods (#175)", () => {
  it("runs each period from a pay date to the day before the next; the last to today, so far", () => {
    const { ranges } = payPeriodRanges(stubs, "2026-01-01", "2026-12-31", TODAY);
    // The October stub isn't paid yet on Sept 30.
    expect(ranges).toEqual([
      { start: "2026-09-04", end: "2026-09-17", inProgress: false },
      { start: "2026-09-18", end: "2026-09-30", inProgress: true },
    ]);
  });

  it("shows a $1,500 paycheck and $1,240 of spending in its period as $260 left over", () => {
    const days = flowDays("2026-09-04", TODAY, [{ date: "2026-09-04", cents: 150_000 }, { date: "2026-09-18", cents: 150_000 }], [
      { date: "2026-09-06", cents: 100_000 },
      { date: "2026-09-12", cents: 24_000 },
      { date: "2026-09-20", cents: 30_000 },
    ]);
    const { periods } = payPeriods({ stubs, from: "2026-01-01", to: "2026-12-31", today: TODAY, days, monthTargets: new Map([["2026-09", 180_000]]) });
    const first = periods.at(-1)!;
    expect(first).toMatchObject({ start: "2026-09-04", payCents: 150_000, outCents: 124_000, leftOverCents: 26_000, otherInCents: 0 });
    // 14 of September's 30 days of a $1,800 month.
    expect(first.targetsCents).toBe(84_000);
    expect(periods[0]).toMatchObject({ inProgress: true, outCents: 30_000 });
  });

  it("gives a $2,000 bonus its own row without changing the regular periods' left over", () => {
    const withBonus = [...stubs, stub("2026-09-10", { netCents: 200_000, oneTime: true })];
    const days = flowDays("2026-09-04", TODAY, [{ date: "2026-09-04", cents: 150_000 }, { date: "2026-09-10", cents: 200_000 }], [{ date: "2026-09-06", cents: 124_000 }]);
    const { periods, oneTime } = payPeriods({ stubs: withBonus, from: "2026-01-01", to: "2026-12-31", today: TODAY, days, monthTargets: new Map() });
    expect(oneTime).toEqual([{ payDate: "2026-09-10", employer: "Synthetic Employer", netCents: 200_000 }]);
    const first = periods.at(-1)!;
    expect(first).toMatchObject({ payCents: 150_000, leftOverCents: 26_000, otherInCents: 200_000 });
    // It doesn't start a period of its own.
    expect(periods).toHaveLength(2);
  });

  it("doesn't count a net-only stub as a regular period", () => {
    const netOnly = stub("2026-09-11", { grossCents: 150_000, lines: [] });
    const { periods, needsGross } = payPeriods({ stubs: [...stubs, netOnly], from: "2026-01-01", to: "2026-12-31", today: TODAY, days: [], monthTargets: new Map() });
    expect(needsGross).toEqual([{ payDate: "2026-09-11", employer: "Synthetic Employer", netCents: 150_000 }]);
    expect(periods.map((p) => p.start)).toEqual(["2026-09-18", "2026-09-04"]);
  });

  it("adds up to the cash flow for the same dates", () => {
    const days = flowDays("2026-09-04", TODAY, [{ date: "2026-09-04", cents: 150_000 }, { date: "2026-09-18", cents: 150_000 }, { date: "2026-09-25", cents: 7_500 }], [
      { date: "2026-09-05", cents: 12_345 },
      { date: "2026-09-29", cents: 6_789 },
    ]);
    const { periods } = payPeriods({ stubs, from: "2026-01-01", to: "2026-12-31", today: TODAY, days, monthTargets: new Map() });
    const all = total(days);
    expect(periods.reduce((s, p) => s + p.outCents, 0)).toBe(all.outCents);
    expect(periods.reduce((s, p) => s + p.inCents, 0)).toBe(all.inCents);
    // The second period's $75 of other income is beside its paycheck, not in it.
    expect(periods[0]).toMatchObject({ payCents: 150_000, otherInCents: 7_500 });
  });

  it("puts two employers paid the same day in one period", () => {
    const two = [stub("2026-09-04"), { ...stub("2026-09-04", { netCents: 50_000 }), employer: "Side Gig" }];
    const { periods } = payPeriods({ stubs: two, from: "2026-01-01", to: "2026-12-31", today: TODAY, days: [], monthTargets: new Map() });
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ payCents: 200_000, employers: ["Synthetic Employer", "Side Gig"] });
  });
});
