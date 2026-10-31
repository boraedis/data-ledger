import { describe, expect, it } from "vitest";
import { parseView, step, switchTo, viewQuery } from "./view";

const TODAY = "2026-10-14"; // a Wednesday

describe("cash flow tabs (#170)", () => {
  it("opens on Annual for the current year", () => {
    expect(parseView({}, TODAY)).toMatchObject({ view: "annual", from: "2026-01-01", to: "2026-12-31", label: "2026" });
  });

  it("keeps the period when switching tabs", () => {
    const march = parseView({ view: "monthly", month: "2026-03" }, TODAY);
    expect(switchTo(march, "annual", TODAY)).toMatchObject({ view: "annual", key: "2026" });
    // The first week starting in March (the 1st is a Sunday), not one that's mostly February.
    expect(switchTo(march, "weekly", TODAY)).toMatchObject({ view: "weekly", key: "2026-03-02", from: "2026-03-02", to: "2026-03-08" });
    expect(switchTo(parseView({ view: "monthly", month: "2026-06" }, TODAY), "weekly", TODAY).key).toBe("2026-06-01");
    const week = parseView({ view: "weekly", week: "2026-03-18" }, TODAY);
    expect(week.key).toBe("2026-03-16");
    expect(switchTo(week, "monthly", TODAY)).toMatchObject({ key: "2026-03" });
    // This year's Annual opens this month, and this month opens this week.
    const year = parseView({}, TODAY);
    expect(switchTo(year, "monthly", TODAY).key).toBe("2026-10");
    expect(switchTo(switchTo(year, "monthly", TODAY), "weekly", TODAY).key).toBe("2026-10-12");
    // An earlier year opens its January.
    expect(switchTo(parseView({ year: "2025" }, TODAY), "monthly", TODAY).key).toBe("2025-01");
  });

  it("steps by its own period, never into the future", () => {
    const week = parseView({ view: "weekly" }, TODAY);
    expect(step(week, -1, TODAY)?.key).toBe("2026-10-05");
    expect(step(week, 1, TODAY)).toBeNull();
    expect(step(parseView({ view: "monthly", month: "2025-12" }, TODAY), 1, TODAY)?.key).toBe("2026-01");
    expect(parseView({ view: "monthly", month: "2027-01" }, TODAY).key).toBe("2026-10");
  });

  it("opens a link from before the tabs on the tab it implies", () => {
    expect(parseView({ month: "2026-03" }, TODAY)).toMatchObject({ view: "monthly", key: "2026-03" });
    expect(parseView({ year: "2025" }, TODAY)).toMatchObject({ view: "annual", key: "2025" });
  });

  it("writes Annual without a view, the others with theirs", () => {
    expect(viewQuery(parseView({}, TODAY))).toEqual({ year: "2026" });
    expect(viewQuery(parseView({ view: "weekly", week: "2026-03-18" }, TODAY))).toEqual({ view: "weekly", week: "2026-03-16" });
  });

  it("labels a week across a year end with both years", () => {
    expect(parseView({ view: "weekly", week: "2025-12-31" }, TODAY).label).toBe("Dec 29, 2025 – Jan 4, 2026");
  });
});
