import { afterEach, describe, expect, it } from "vitest";
import { MASKED_AMOUNT } from "@/lib/money";
import { percentOf, pointsOf, showProportions } from "@/lib/privacy/share";
import { setBrowserPrivacy } from "@/lib/privacy/state";

// Proportions in privacy mode (#366), on invented figures: each base the
// key views use, and the edge where there's no base.

const g = globalThis as { window?: unknown };
afterEach(() => {
  setBrowserPrivacy(false);
  delete g.window;
});

describe("a share", () => {
  it("of today's net worth: today is 100%, a year ago a share of it", () => {
    expect(percentOf(250_000_00, 250_000_00)).toBe("100%");
    expect(percentOf(200_000_00, 250_000_00)).toBe("80%");
    // An account's share, and a loan's, which takes away.
    expect(percentOf(12_345_00, 250_000_00)).toBe("4.9%");
    expect(percentOf(-50_000_00, 250_000_00)).toBe("−20%");
  });

  it("of a budget's target, of a period's spending, and of income, the same way", () => {
    expect(percentOf(450_00, 600_00)).toBe("75%");
    expect(percentOf(660_00, 600_00)).toBe("110%");
    expect(percentOf(3_00, 1_000_00)).toBe("0.3%");
  });

  it("has no base below zero: a net worth under water stays masked", () => {
    expect(percentOf(100, 0)).toBe(MASKED_AMOUNT);
    expect(percentOf(100, -5_000)).toBe(MASKED_AMOUNT);
    expect(pointsOf(100, -5_000)).toBe(MASKED_AMOUNT);
  });

  it("reads a change in points of the base", () => {
    expect(pointsOf(7_500_00, 250_000_00)).toBe("+3 pts");
    expect(pointsOf(-30_000_00, 250_000_00)).toBe("−12 pts");
    expect(pointsOf(0, 250_000_00)).toBe("0 pts");
  });
});

describe("when the views show them", () => {
  it("is privacy mode, by the formatter's rules", () => {
    expect(showProportions()).toBe(false);
    g.window = {};
    setBrowserPrivacy(true, "s1");
    expect(showProportions()).toBe(true);
  });
});
