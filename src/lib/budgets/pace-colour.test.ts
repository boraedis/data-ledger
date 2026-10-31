import { describe, expect, it } from "vitest";
import { elapsedShare } from "@/lib/pace";
import { paceFor, paceSegments, paceTone, singleColour } from "./pace-colour";

// A $300 monthly Dining budget, 10 days into a 30-day month: pace $100.
const pace = paceFor(30_000, elapsedShare("2026-09-01", "2026-09-30", "2026-09-10"));

describe("pace colours (#159)", () => {
  it("puts the pace at the budget's share of the period elapsed", () => {
    expect(pace).toBe(10_000);
    // A finished period has no pace.
    expect(paceFor(30_000, 1)).toBeNull();
  });

  it("is green on pace", () => {
    expect(paceTone(10_000, 30_000, pace)).toBe("within");
    expect(paceSegments(10_000, 30_000, pace)).toEqual([{ colour: "green", cents: 10_000 }]);
  });

  it("is green to the pace line and yellow after it when ahead of pace but under budget", () => {
    expect(paceSegments(15_000, 30_000, pace)).toEqual([
      { colour: "green", cents: 10_000 },
      { colour: "yellow", cents: 5_000 },
    ]);
  });

  it("is yellow to the budget and red after it when over", () => {
    expect(paceSegments(35_000, 30_000, pace)).toEqual([
      { colour: "yellow", cents: 30_000 },
      { colour: "red", cents: 5_000 },
    ]);
  });

  it("shows a single-colour square ahead of pace as yellow", () => {
    expect(singleColour(paceTone(15_000, 30_000, pace))).toBe("yellow");
    expect(singleColour(paceTone(10_000, 30_000, pace))).toBe("green");
    expect(singleColour(paceTone(35_000, 30_000, pace))).toBe("red");
  });

  it("splits a finished month over budget yellow and red, not all red", () => {
    expect(paceSegments(35_000, 30_000, paceFor(30_000, 1))).toEqual([
      { colour: "yellow", cents: 30_000 },
      { colour: "red", cents: 5_000 },
    ]);
    expect(paceSegments(25_000, 30_000, null)).toEqual([{ colour: "green", cents: 25_000 }]);
  });

  it("draws nothing for $0 or a net refund, and all red with no budget", () => {
    expect(paceSegments(0, 30_000, pace)).toEqual([]);
    expect(paceSegments(-2_000, 30_000, pace)).toEqual([]);
    expect(paceSegments(5_000, 0, null)).toEqual([{ colour: "red", cents: 5_000 }]);
  });
});
