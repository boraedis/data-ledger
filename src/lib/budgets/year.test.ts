import { describe, expect, it } from "vitest";
import { sumCells, yearTotals } from "./year";

// Made-up rows over four months: a target that started in month 2, and one
// that ran all four.
const started = { months: [{ spentCents: 9_000, targetCents: null }, { spentCents: 30_000, targetCents: 25_000 }, { spentCents: 20_000, targetCents: 25_000 }, { spentCents: 0, targetCents: 25_000 }] };
const always = { months: [{ spentCents: 10_000, targetCents: 12_000 }, { spentCents: 12_000, targetCents: 12_000 }, { spentCents: 15_000, targetCents: 12_000 }, { spentCents: 5_000, targetCents: 12_000 }] };

describe("Year view totals (#124)", () => {
  it("adds up a row's months that had a target, and nothing from the months that didn't", () => {
    expect(sumCells(started.months)).toEqual({ spentCents: 50_000, targetCents: 75_000, months: 3 });
    expect(sumCells([{ spentCents: 4_000, targetCents: null }])).toBeNull();
  });

  it("totals each month across targets, and the grid as the sum of its rows and of its columns", () => {
    const t = yearTotals([started, always]);
    expect(t.byColumn[0]).toEqual({ spentCents: 10_000, targetCents: 12_000, months: 1 });
    expect(t.byColumn[1]).toEqual({ spentCents: 42_000, targetCents: 37_000, months: 2 });
    expect(t.total).toEqual({ spentCents: 92_000, targetCents: 123_000, months: 7 });
    const rows = t.byRow.reduce((s, r) => s + r!.spentCents, 0);
    const cols = t.byColumn.reduce((s, c) => s + (c?.spentCents ?? 0), 0);
    expect(rows).toBe(t.total!.spentCents);
    expect(cols).toBe(t.total!.spentCents);
  });
});
