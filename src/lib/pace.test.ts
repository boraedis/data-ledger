import { describe, expect, it } from "vitest";
import { daysInclusive, elapsedShare, evenPace, monthlyNeeded, monthsLeft } from "@/lib/pace";

describe("pace", () => {
  it("measures elapsed share inclusively, clamped", () => {
    expect(daysInclusive("2026-01-01", "2026-12-31")).toBe(365);
    expect(elapsedShare("2026-01-01", "2026-12-31", "2026-04-15")).toBeCloseTo(105 / 365);
    expect(elapsedShare("2026-01-01", "2026-12-31", "2025-12-01")).toBe(0);
    expect(elapsedShare("2026-01-01", "2026-12-31", "2027-02-01")).toBe(1);
  });

  it("puts an even pace on the line between start and target", () => {
    expect(evenPace(0, 1_200, 0.25)).toBe(300);
    expect(evenPace(1_000, 3_000, 0.5)).toBe(2_000);
  });

  it("spreads what's left over the months remaining, this one included", () => {
    expect(monthsLeft("2026-10-13", "2026-12-31")).toBe(3);
    expect(monthsLeft("2026-10-13", "2026-10-20")).toBe(1);
    expect(monthlyNeeded(90_000, "2026-10-13", "2026-12-31")).toBe(30_000);
    expect(monthlyNeeded(100, "2026-10-13", "2026-12-31")).toBe(34);
    expect(monthlyNeeded(100, "2026-10-13", "2026-09-30")).toBeNull();
  });
});
