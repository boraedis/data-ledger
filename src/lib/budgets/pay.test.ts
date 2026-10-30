import { describe, expect, it } from "vitest";
import { payForMonth, paySummary } from "./pay";

// Made-up biweekly stubs, $1,500 net each.
const stub = (payDate: string, netCents = 150_000, oneTime = false) => ({ payDate, periodStart: payDate, periodEnd: payDate, netCents, oneTime });
const biweekly = ["2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16"].map((d) => stub(d));

describe("pay against the budget (#128)", () => {
  it("shows the issue's example: $3,000 pay, $2,400 targets, $2,150 spent", () => {
    const s = paySummary({ netPayCents: 300_000, targetsCents: 240_000, spentCents: 215_000 });
    expect(s.expectedSaving).toEqual({ cents: 60_000, percent: 20 });
    expect(s.actualSaving).toEqual({ cents: 85_000, percent: 28 });
    expect(s.targets.percent).toBe(80);
  });

  it("counts every paycheck dated in a past month, and none as no pay recorded", () => {
    expect(payForMonth("2026-09", "2026-10-30", biweekly)).toMatchObject({ recordedCount: 2, netPayCents: 300_000, expectedCount: 0 });
    expect(payForMonth("2026-07", "2026-10-30", biweekly).netPayCents).toBeNull();
  });

  it("adds this month's paychecks still to come at the recent pace, and a bonus counts but doesn't set it", () => {
    // Paid Oct 2 and 16; the 30th is still to come on the 20th.
    const withBonus = [...biweekly, stub("2026-10-09", 500_000, true)];
    const pay = payForMonth("2026-10", "2026-10-20", withBonus);
    expect(pay).toMatchObject({ recordedCount: 3, recordedCents: 800_000, expectedCount: 1, expectedCents: 150_000, netPayCents: 950_000 });
    // On the 30th it's recorded, so nothing more is expected.
    expect(payForMonth("2026-10", "2026-10-30", [...biweekly, stub("2026-10-30")])).toMatchObject({ recordedCount: 3, expectedCount: 0 });
  });

  it("has no pay at all with no stubs", () => {
    expect(payForMonth("2026-10", "2026-10-20", []).netPayCents).toBeNull();
  });
});
