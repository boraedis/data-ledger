import { describe, expect, it } from "vitest";
import { comparedWith, parseView, step, switchTo, viewQuery } from "./view";

const TODAY = "2026-10-14"; // a Wednesday

describe("cash flow tabs (#170, #175)", () => {
  it("opens on Annual for the current year", () => {
    expect(parseView({}, TODAY)).toMatchObject({ view: "annual", from: "2026-01-01", to: "2026-12-31", label: "2026" });
  });

  it("keeps the period when switching tabs", () => {
    const march = parseView({ view: "monthly", month: "2026-03" }, TODAY);
    expect(switchTo(march, "annual", TODAY)).toMatchObject({ view: "annual", key: "2026" });
    expect(switchTo(march, "pay", TODAY)).toMatchObject({ view: "pay", key: "2026" });
    // This year opens this month; an earlier year, its January.
    expect(switchTo(parseView({ view: "pay" }, TODAY), "monthly", TODAY).key).toBe("2026-10");
    expect(switchTo(parseView({ year: "2025" }, TODAY), "monthly", TODAY).key).toBe("2025-01");
    expect(switchTo(parseView({ view: "pay", year: "2025" }, TODAY), "annual", TODAY).key).toBe("2025");
  });

  it("steps by its own period, never into the future", () => {
    expect(step(parseView({ view: "pay" }, TODAY), -1, TODAY)?.key).toBe("2025");
    expect(step(parseView({ view: "pay" }, TODAY), 1, TODAY)).toBeNull();
    expect(step(parseView({ view: "monthly", month: "2025-12" }, TODAY), 1, TODAY)?.key).toBe("2026-01");
    expect(parseView({ view: "monthly", month: "2027-01" }, TODAY).key).toBe("2026-10");
  });

  it("opens older links on the tab they imply, the old Weekly on the week's month", () => {
    expect(parseView({ month: "2026-03" }, TODAY)).toMatchObject({ view: "monthly", key: "2026-03" });
    expect(parseView({ year: "2025" }, TODAY)).toMatchObject({ view: "annual", key: "2025" });
    expect(parseView({ view: "weekly", week: "2026-03-16" }, TODAY)).toMatchObject({ view: "monthly", key: "2026-03" });
  });

  it("writes Annual without a view, the others with theirs", () => {
    expect(viewQuery(parseView({}, TODAY))).toEqual({ year: "2026" });
    expect(viewQuery(parseView({ view: "pay", year: "2025" }, TODAY))).toEqual({ view: "pay", year: "2025" });
  });
});

describe("the month before (#172)", () => {
  it("compares a whole month with the whole month before", () => {
    expect(comparedWith(parseView({ view: "monthly", month: "2026-03" }, TODAY), TODAY)).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "February" });
  });

  it("compares the month in progress with the same days of the month before, clipped to its length", () => {
    expect(comparedWith(parseView({ view: "monthly" }, TODAY), TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-14", label: "September 1–14" });
    expect(comparedWith(parseView({ view: "monthly" }, "2026-03-31"), "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "February" });
  });
});
