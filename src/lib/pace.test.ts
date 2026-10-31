import { describe, expect, it } from "vitest";
import { daysInclusive, elapsedShare, evenPace, monthlyNeeded, monthsLeft, projectAtEnd } from "@/lib/pace";

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

  it("projects spending to the end of a span at its pace so far (#147)", () => {
    // $150 by day 10 of a 30-day month: $450.
    expect(projectAtEnd(15_000, elapsedShare("2026-09-01", "2026-09-30", "2026-09-10"))).toBe(45_000);
    // On the last day, the projection is the spend.
    expect(projectAtEnd(15_000, elapsedShare("2026-09-01", "2026-09-30", "2026-09-30"))).toBe(15_000);
    expect(projectAtEnd(0, 0.5)).toBeNull();
    expect(projectAtEnd(-2_000, 0.5)).toBeNull();
  });

  it("spreads what's left over the months remaining, this one included", () => {
    expect(monthsLeft("2026-10-13", "2026-12-31")).toBe(3);
    expect(monthsLeft("2026-10-13", "2026-10-20")).toBe(1);
    expect(monthlyNeeded(90_000, "2026-10-13", "2026-12-31")).toBe(30_000);
    expect(monthlyNeeded(100, "2026-10-13", "2026-12-31")).toBe(34);
    expect(monthlyNeeded(100, "2026-10-13", "2026-09-30")).toBeNull();
  });
});

describe("projecting a quarter from its first month (#194)", () => {
  it("carries the spending so far over the whole period, by day", () => {
    // $80 spent by Oct 31 of an Oct–Dec period: 31 of 92 days.
    const share = elapsedShare("2026-10-01", "2026-12-31", "2026-10-31");
    expect(share).toBeCloseTo(31 / 92, 10);
    expect(projectAtEnd(8_000, share)).toBe(23_742);
  });

  it("has no projection once the period is over or before anything is spent", () => {
    expect(projectAtEnd(0, 0.34)).toBeNull();
    expect(elapsedShare("2026-10-01", "2026-12-31", "2026-12-31")).toBe(1);
  });
});
