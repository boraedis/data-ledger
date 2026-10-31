import { describe, expect, it } from "vitest";
import { flowDays, rollUp, total, weekStart } from "./series";

describe("cash flow series (#169)", () => {
  it("puts a $3,000 paycheck and $200 of groceries in a week as $3,000 in, $200 out, $2,800 net", () => {
    const days = flowDays("2026-09-07", "2026-09-13", [{ date: "2026-09-11", cents: 300_000 }], [
      { date: "2026-09-08", cents: 12_000 },
      { date: "2026-09-12", cents: 8_000 },
    ]);
    expect(total(days)).toEqual({ inCents: 300_000, outCents: 20_000, netCents: 280_000 });
  });

  it("counts a refund against its day's spending", () => {
    const days = flowDays("2026-09-01", "2026-09-02", [], [{ date: "2026-09-01", cents: 5_000 }, { date: "2026-09-01", cents: -1_500 }]);
    expect(days[0].outCents).toBe(3_500);
  });

  it("makes a month equal its days, and its weeks for the days they share", () => {
    const ins = [{ date: "2026-09-01", cents: 300_000 }, { date: "2026-09-15", cents: 300_000 }];
    const outs = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, cents: 1_000 * (i + 1) }));
    const days = flowDays("2026-09-01", "2026-09-30", ins, outs);
    const [month] = rollUp(days, "month");
    expect(month).toMatchObject({ start: "2026-09-01", end: "2026-09-30", days: 30, ...total(days) });
    const weeks = rollUp(days, "week");
    // Clipped to the month: the first week starts on Tuesday the 1st.
    expect(weeks[0]).toMatchObject({ start: "2026-09-01", end: "2026-09-06", days: 6 });
    expect(weeks.reduce((s, w) => s + w.outCents, 0)).toBe(month.outCents);
    expect(weeks.reduce((s, w) => s + w.inCents, 0)).toBe(month.inCents);
  });

  it("rolls a year up into twelve months that add up to it", () => {
    const days = flowDays("2026-01-01", "2026-12-31", [{ date: "2026-03-31", cents: 100 }, { date: "2026-04-01", cents: 200 }], []);
    const months = rollUp(days, "month");
    expect(months).toHaveLength(12);
    expect(months[2].inCents).toBe(100);
    expect(months[3].inCents).toBe(200);
  });

  it("starts weeks on Monday", () => {
    expect(weekStart("2026-09-13")).toBe("2026-09-07"); // Sunday
    expect(weekStart("2026-09-07")).toBe("2026-09-07"); // Monday
  });
});
