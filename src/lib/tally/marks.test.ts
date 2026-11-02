import { describe, expect, it } from "vitest";
import { MAX_MARKS, tallyMarks } from "@/lib/tally/marks";

describe("tallyMarks", () => {
  it("draws one stroke per count: four uprights and a diagonal make five", () => {
    for (const n of [1, 2, 4, 5, 6, 9, 10, 14, MAX_MARKS]) expect(tallyMarks(n)?.strokes).toHaveLength(n);
  });

  it("crosses each group of five with a stroke that spans the four", () => {
    const five = tallyMarks(5)!;
    const [diagonal] = five.strokes.filter((s) => s.x1 !== s.x2);
    const uprights = five.strokes.filter((s) => s.x1 === s.x2);
    expect(uprights).toHaveLength(4);
    expect(diagonal.x1).toBeLessThanOrEqual(Math.min(...uprights.map((s) => s.x1)));
    expect(diagonal.x2).toBeGreaterThanOrEqual(Math.max(...uprights.map((s) => s.x1)));
  });

  it("starts the next group clear of the last, and sizes the box to what's drawn", () => {
    const six = tallyMarks(6)!;
    const lastX = Math.max(...six.strokes.map((s) => Math.max(s.x1, s.x2)));
    expect(lastX).toBeLessThan(six.width);
    expect(tallyMarks(5)!.width).toBeLessThan(tallyMarks(6)!.width);
  });

  it("draws nothing for none, for too many, or for a count that isn't whole", () => {
    for (const n of [0, -1, 1.5, MAX_MARKS + 1, Number.NaN]) expect(tallyMarks(n)).toBeNull();
  });
});
