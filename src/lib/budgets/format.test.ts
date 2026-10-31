import { describe, expect, it } from "vitest";
import { projectionLabel, suggestedTargetCents } from "./format";

const months = (n: number) => Array.from({ length: n }, (_, i) => ({ month: `2026-0${i + 3}-01`, spentCents: 1 }));
const h = (averageCents: number | null, n: number) => ({ averageCents, months: months(n), overMonths: null, comparedMonths: 0 });

describe("suggestedTargetCents (#106)", () => {
  it("suggests nothing with fewer than two months of history", () => {
    expect(suggestedTargetCents(undefined, 1)).toBeNull();
    expect(suggestedTargetCents(h(null, 0), 1)).toBeNull();
    expect(suggestedTargetCents(h(23_770, 1), 1)).toBeNull();
    expect(suggestedTargetCents(h(23_770, 2), 1)).toBe(23_800);
  });

  it("rounds to whole dollars, scaling to the period before rounding", () => {
    expect(suggestedTargetCents(h(23_749, 3), 1)).toBe(23_700);
    expect(suggestedTargetCents(h(23_750, 3), 1)).toBe(23_800);
    // $237.49 × 12 = $2,849.88, not 12 × $237.
    expect(suggestedTargetCents(h(23_749, 3), 12)).toBe(285_000);
    expect(suggestedTargetCents(h(23_749, 3), 3)).toBe(71_200);
  });

  it("suggests nothing that would round to zero", () => {
    expect(suggestedTargetCents(h(40, 3), 1)).toBeNull();
  });
});

describe("projectionLabel (#147)", () => {
  it("says how far over the projection lands, or that it's on track", () => {
    expect(projectionLabel({ projectedCents: 45_000, availableCents: 30_000, end: "2026-09-30" })).toEqual({ text: "Projected $450.00 by Sep 30, $150.00 over", over: true });
    expect(projectionLabel({ projectedCents: 30_000, availableCents: 30_000, end: "2026-09-30" })).toEqual({ text: "On track: about $300.00 by Sep 30", over: false });
    expect(projectionLabel({ projectedCents: null, availableCents: 30_000, end: "2026-09-30" })).toEqual({ text: "Nothing spent yet", over: false });
  });
});
