import { describe, expect, it } from "vitest";
import { paceFor, paceTone } from "./pace-colour";
import { gridSegments, periodBudget, segmentFigures, sumCells, yearTotals } from "./year";

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

describe("Year view periods (#157)", () => {
  const months = (from: string, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(`${from}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + i);
      return d.toISOString().slice(0, 10);
    });
  const period = (start: string, end: string, periodMonths: number, targetCents: number, spentCents: number) => ({ start, end, periodMonths, targetCents, spentCents });

  it("makes a quarter one box across its three months, with the period's figures", () => {
    const q1 = period("2026-01-01", "2026-03-31", 3, 90_000, 100_000);
    const q2 = period("2026-04-01", "2026-06-30", 3, 90_000, 20_000);
    const cells = months("2026-01", 6).map((month, i) => ({ month, targetCents: 30_000, spentCents: [40_000, 30_000, 30_000, 20_000, 0, 0][i], period: i < 3 ? q1 : q2 }));
    const s = gridSegments(cells);
    expect(s.map((x) => [x.first, x.cells.length])).toEqual([[0, 3], [3, 3]]);
    // $900 target, $1,000 spent: $100 over.
    expect(segmentFigures(s[0])).toEqual({ spentCents: 100_000, targetCents: 90_000 });
  });

  it("spans all twelve months for an annual target starting in January", () => {
    const year = period("2026-01-01", "2026-12-31", 12, 120_000, 50_000);
    const s = gridSegments(months("2026-01", 12).map((month) => ({ month, targetCents: 10_000, spentCents: 0, period: year })));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ first: 0, clippedBefore: false, clippedAfter: false });
    expect(s[0].cells).toHaveLength(12);
  });

  it("follows the anchor: a quarter from February is February to April, clipped at the edges", () => {
    const nov = period("2025-11-01", "2026-01-31", 3, 90_000, 0);
    const feb = period("2026-02-01", "2026-04-30", 3, 90_000, 0);
    const may = period("2026-05-01", "2026-07-31", 3, 90_000, 0);
    const cells = months("2026-01", 6).map((month, i) => ({ month, targetCents: 30_000, spentCents: 0, period: [nov, feb, feb, feb, may, may][i] }));
    const s = gridSegments(cells);
    expect(s.map((x) => [x.first, x.cells.length, x.clippedBefore, x.clippedAfter])).toEqual([
      [0, 1, true, false],
      [1, 3, false, false],
      [4, 2, false, true],
    ]);
  });

  it("leaves monthly targets and months without a target as single cells", () => {
    const monthly = period("2026-01-01", "2026-01-31", 1, 30_000, 10_000);
    const s = gridSegments([
      { month: "2026-01-01", targetCents: 30_000, spentCents: 10_000, period: monthly },
      { month: "2026-02-01", targetCents: null, spentCents: 5_000, period: null },
    ]);
    expect(s.map((x) => [x.cells.length, x.period])).toEqual([[1, null], [1, null]]);
    expect(segmentFigures(s[0])).toEqual({ spentCents: 10_000, targetCents: 30_000 });
    expect(segmentFigures(s[1])).toBeNull();
  });
});

// A quarterly period is held to what's available (target plus rollover and
// moved budget), as on the target's card (#194). Synthetic values.
describe("a period's budget", () => {
  it("is the available amount, falling back to the target", () => {
    expect(periodBudget({ targetCents: 30_000, availableCents: 30_300 })).toBe(30_300);
    expect(periodBudget({ targetCents: 30_000 })).toBe(30_000);
  });

  it("gives a box the same over/under and pace as the card", () => {
    const period = { start: "2026-10-01", end: "2026-12-31", periodMonths: 3, targetCents: 30_000, availableCents: 30_300, spentCents: 10_150 };
    const cells = [{ month: "2026-10-01", targetCents: 10_000, spentCents: 10_150, period }];
    const [seg] = gridSegments(cells);
    // Held to $303, not $300.
    expect(segmentFigures(seg)).toEqual({ spentCents: 10_150, targetCents: 30_300 });
    // 31 of 92 days in: the pace on $303 is $102, so $101.50 is on pace (green); on the bare $300 it was $101, ahead (yellow).
    const share = 31 / 92;
    expect(paceTone(10_150, periodBudget(period), paceFor(periodBudget(period), share))).toBe("within");
    expect(paceTone(10_150, period.targetCents, paceFor(period.targetCents, share))).toBe("ahead");
  });

  // Same for every period longer than a month: 3, 6 and 12 months. Synthetic values.
  it.each([
    { name: "6-month", start: "2026-07-01", end: "2026-12-31", periodMonths: 6, target: 60_000, available: 60_600, days: 31, total: 184, months: ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"] },
    { name: "annual", start: "2026-01-01", end: "2026-12-31", periodMonths: 12, target: 120_000, available: 121_200, days: 304, total: 365, months: ["2026-09-01", "2026-10-01"] },
  ])("holds a $name period to what's available", ({ start, end, periodMonths, target, available, days, total, months }) => {
    // Spent just above the pace on the target, below the pace on the available amount.
    const share = days / total;
    const spent = Math.round(target * share) + 1;
    expect(paceFor(available, share)!).toBeGreaterThan(spent);
    const period = { start, end, periodMonths, targetCents: target, availableCents: available, spentCents: spent };
    const segments = gridSegments(months.map((month) => ({ month, targetCents: target / periodMonths, spentCents: 0, period })));
    // One box for the whole period, held to the available amount.
    expect(segments).toHaveLength(1);
    expect(segmentFigures(segments[0])).toEqual({ spentCents: spent, targetCents: available });
    expect(paceTone(spent, periodBudget(period), paceFor(periodBudget(period), share))).toBe("within");
    expect(paceTone(spent, target, paceFor(target, share))).toBe("ahead");
  });
});
