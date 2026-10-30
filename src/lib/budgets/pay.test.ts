import { describe, expect, it } from "vitest";
import { payForMonth, paySummary, typicalMonth } from "./pay";

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

describe("a typical month's pay (#142)", () => {
  // Made-up biweekly $3,000 paychecks through 2026, starting Jan 2.
  const paychecks = Array.from({ length: 26 }, (_, i) => stub(new Date(Date.parse("2026-01-02") + i * 14 * 86_400_000).toISOString().slice(0, 10), 300_000));

  it("is the recent paycheck times 26 over 12: $6,500, against $9,000 landed in a 3-paycheck month and $6,000 in a 2-paycheck one", () => {
    expect(typicalMonth(paychecks, "2026-12-31")).toEqual({ cents: 650_000, paceCents: 300_000, perYear: 26 });
    // January 2026 has three paydays (2, 16, 30); February two.
    expect(payForMonth("2026-01", "2026-12-31", paychecks).netPayCents).toBe(900_000);
    expect(payForMonth("2026-02", "2026-12-31", paychecks).netPayCents).toBe(600_000);
  });

  it("gives months with different paychecks the same expected saving", () => {
    const typical = typicalMonth(paychecks, "2026-12-31")!.cents;
    const jan = paySummary({ netPayCents: typical, targetsCents: 500_000, spentCents: 450_000 });
    const feb = paySummary({ netPayCents: typical, targetsCents: 500_000, spentCents: 470_000 });
    expect(jan.expectedSaving).toEqual(feb.expectedSaving);
    expect(jan.expectedSaving).toEqual({ cents: 150_000, percent: 23 });
  });

  it("isn't set by a bonus, which lands as extra in its month", () => {
    const withBonus = [...paychecks, stub("2026-03-06", 1_000_000, true)];
    expect(typicalMonth(withBonus, "2026-12-31")!.cents).toBe(650_000);
    expect(payForMonth("2026-03", "2026-12-31", withBonus).netPayCents).toBe(600_000 + 1_000_000);
  });

  it("follows the pay of the time, and has none without regular stubs", () => {
    const raised = [...paychecks.slice(0, 10), ...paychecks.slice(10).map((s) => ({ ...s, netCents: 330_000 }))];
    expect(typicalMonth(raised, "2026-03-31")!.cents).toBe(650_000);
    expect(typicalMonth(raised, "2026-12-31")!.cents).toBe(715_000);
    expect(typicalMonth([stub("2026-03-06", 1_000_000, true)], "2026-12-31")).toBeNull();
  });
});
