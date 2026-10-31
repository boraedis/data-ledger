import { describe, expect, it } from "vitest";
import {
  BUFFER,
  budgetStatus,
  changeEffectiveFrom,
  firstOfMonth,
  lastOfMonth,
  monthIndex,
  naturalPeriod,
  recentHistory,
  type CategoryInfo,
  type SpendLine,
  type TargetVersion,
} from "@/lib/budgets/engine";

// All amounts invented. Lines are signed like transactions: −$50 = spent.

const cats: CategoryInfo[] = [
  { id: "food", parentId: null, kind: "expense" },
  { id: "groceries", parentId: "food", kind: "expense" },
  { id: "dining", parentId: "food", kind: "expense" },
  { id: "car", parentId: null, kind: "expense" },
  { id: "gifts", parentId: null, kind: "expense" },
  { id: "paycheck", parentId: null, kind: "income" },
  { id: "transfers", parentId: null, kind: "transfer" },
];

const v = (overrides: Partial<TargetVersion>): TargetVersion => ({
  categoryId: "food",
  effectiveFrom: "2026-01-01",
  amountCents: 50_000,
  periodMonths: 1,
  anchorOn: "2026-01-01",
  rollover: false,
  sinkingFund: false,
  ...overrides,
});
const spend = (date: string, categoryId: string, dollars: number): SpendLine => ({ date, categoryId, amountCents: -dollars * 100 });

const status = (on: string, versions: TargetVersion[], lines: SpendLine[], adjustments = [] as { categoryId: string | null; on: string; amountCents: number }[]) =>
  budgetStatus({ on, versions, lines, categories: cats, adjustments });
const target = (s: ReturnType<typeof status>, key: string) => s.targets.find((t) => t.key === key)!;

describe("months and periods", () => {
  it("handles month arithmetic across years and month lengths", () => {
    expect(firstOfMonth(monthIndex("2026-12-31") + 1)).toBe("2027-01-01");
    expect(lastOfMonth(monthIndex("2028-02-10"))).toBe("2028-02-29");
    expect(lastOfMonth(monthIndex("2026-02-10"))).toBe("2026-02-28");
  });

  it("finds the period containing a month from its anchor, before or after it", () => {
    const quarter = (date: string) => {
      const p = naturalPeriod(monthIndex(date), 3, "2026-02-01");
      return [firstOfMonth(p.start), lastOfMonth(p.end)];
    };
    expect(quarter("2026-03-15")).toEqual(["2026-02-01", "2026-04-30"]);
    expect(quarter("2026-01-15")).toEqual(["2025-11-01", "2026-01-31"]);
  });

  it("starts a change at the current period, and a new annual target at the year's start", () => {
    expect(changeEffectiveFrom(null, { periodMonths: 1, anchorOn: "2026-01-01" }, "2026-10-13")).toBe("2026-10-01");
    expect(changeEffectiveFrom(null, { periodMonths: 12, anchorOn: "2026-01-01" }, "2026-10-13")).toBe("2026-01-01");
    // Changing an existing monthly target to annual starts at this month, under the old schedule.
    expect(changeEffectiveFrom(v({}), { periodMonths: 12, anchorOn: "2026-01-01" }, "2026-10-13")).toBe("2026-10-01");
  });
});

describe("budgetStatus", () => {
  it("measures net spend per period, with refunds offsetting and non-spending ignored", () => {
    const s = status("2026-03-20", [v({})], [
      spend("2026-03-02", "food", 120),
      spend("2026-03-05", "food", -20), // a refund
      spend("2026-02-27", "food", 999), // last month
      { date: "2026-03-01", categoryId: "paycheck", amountCents: 500_000 },
      spend("2026-03-03", "transfers", 300),
    ]);
    expect(target(s, "food")).toMatchObject({ start: "2026-03-01", end: "2026-03-31", targetCents: 50_000, spentCents: 10_000, remainingCents: 40_000 });
  });

  it("counts a child toward its parent's target unless it has its own, and the rest toward the buffer", () => {
    const s = status(
      "2026-03-20",
      [v({}), v({ categoryId: "dining", amountCents: 20_000 }), v({ categoryId: null, amountCents: 30_000 })],
      [spend("2026-03-02", "groceries", 100), spend("2026-03-03", "dining", 40), spend("2026-03-04", "car", 60), spend("2026-03-05", "gifts", 25)],
    );
    expect(target(s, "food").spentCents).toBe(10_000);
    expect(target(s, "dining").spentCents).toBe(4_000);
    expect(target(s, BUFFER)).toMatchObject({ spentCents: 8_500, remainingCents: 21_500 });
    expect(s.unbudgeted.byCategory).toEqual([
      { categoryId: "car", spentCents: 6_000 },
      { categoryId: "gifts", spentCents: 2_500 },
    ]);
    expect(s.targets[0].key).toBe(BUFFER);
  });

  it("lists unbudgeted spending for the calendar month even without a buffer target", () => {
    const s = status("2026-03-20", [v({})], [spend("2026-03-04", "car", 60), spend("2026-02-04", "car", 70)]);
    expect(s.unbudgeted).toEqual({ start: "2026-03-01", end: "2026-03-31", byCategory: [{ categoryId: "car", spentCents: 6_000 }] });
  });

  it("keeps past periods on the target they had when a later version changes it", () => {
    const versions = [v({}), v({ effectiveFrom: "2026-03-01", amountCents: 80_000 })];
    expect(target(status("2026-02-10", versions, []), "food").targetCents).toBe(50_000);
    expect(target(status("2026-03-10", versions, []), "food").targetCents).toBe(80_000);
  });

  it("clips and prorates the first period when the schedule changes mid-year", () => {
    // Monthly until October, then $1,200 a year anchored on January.
    const versions = [v({}), v({ effectiveFrom: "2026-10-01", amountCents: 120_000, periodMonths: 12 })];
    const oct = target(status("2026-10-13", versions, [spend("2026-09-30", "food", 200), spend("2026-10-02", "food", 50)]), "food");
    expect(oct).toMatchObject({ start: "2026-10-01", end: "2026-12-31", targetCents: 30_000, spentCents: 5_000 });
    expect(target(status("2027-05-01", versions, []), "food")).toMatchObject({ start: "2027-01-01", end: "2027-12-31", targetCents: 120_000 });
  });

  it("rolls the remainder (or overspend) forward while rollover stays on", () => {
    const versions = [v({ rollover: true })];
    const lines = [spend("2026-01-10", "food", 400), spend("2026-02-10", "food", 600)];
    expect(target(status("2026-02-15", versions, lines), "food")).toMatchObject({ carryInCents: 10_000, availableCents: 60_000, remainingCents: 0 });
    expect(target(status("2026-03-15", versions, lines), "food")).toMatchObject({ carryInCents: 0, availableCents: 50_000 });
    const over = [spend("2026-01-10", "food", 700)];
    expect(target(status("2026-02-15", versions, over), "food").carryInCents).toBe(-20_000);
    // Without rollover each period starts clean.
    expect(target(status("2026-02-15", [v({})], lines), "food").carryInCents).toBe(0);
  });

  it("resets the carry when a target ends and later restarts", () => {
    const versions = [
      v({ rollover: true }),
      v({ effectiveFrom: "2026-02-01", amountCents: null, rollover: true }),
      v({ effectiveFrom: "2026-03-01", rollover: true }),
    ];
    expect(status("2026-02-15", versions, []).targets.find((t) => t.key === "food")).toBeUndefined();
    expect(target(status("2026-03-15", versions, []), "food").carryInCents).toBe(0);
  });

  it("shows year-to-date progress, an even pace and a sinking-fund set-aside for annual targets", () => {
    const versions = [v({ categoryId: "car", amountCents: 120_000, periodMonths: 12, sinkingFund: true })];
    const t = target(status("2026-04-15", versions, [spend("2026-02-01", "car", 400), spend("2026-03-20", "car", 100)]), "car");
    expect(t).toMatchObject({ start: "2026-01-01", end: "2026-12-31", spentCents: 50_000, setAsideMonthlyCents: 10_000, setAsideByNowCents: 40_000 });
    // 105 of 365 days.
    expect(t.paceCents).toBe(Math.round(120_000 * (105 / 365)));
    expect(target(status("2026-04-15", [v({})], []), "food").paceCents).toBeNull();
  });

  it("projects the period's end from its pace so far (#147)", () => {
    const versions = [v({ amountCents: 30_000 })];
    // $300 target, $150 by day 10 of September: $450, $150 over.
    const t = target(status("2026-09-10", versions, [spend("2026-09-03", "dining", 100), spend("2026-09-09", "groceries", 50)]), "food");
    expect(t.projectedCents).toBe(45_000);
    expect(t.projectedCents! - t.availableCents).toBe(15_000);
    // On the last day, the spend itself.
    expect(target(status("2026-09-30", versions, [spend("2026-09-03", "dining", 150)]), "food").projectedCents).toBe(15_000);
    // Nothing spent yet: no projection.
    expect(target(status("2026-09-10", versions, []), "food").projectedCents).toBeNull();
  });

  it("applies rebalancing adjustments to the period they fall in only", () => {
    const versions = [v({}), v({ categoryId: "car", amountCents: 20_000 })];
    const adjustments = [
      { categoryId: "food", on: "2026-03-10", amountCents: -5_000 },
      { categoryId: "car", on: "2026-03-10", amountCents: 5_000 },
    ];
    const march = status("2026-03-20", versions, [], adjustments);
    expect(target(march, "food").availableCents).toBe(45_000);
    expect(target(march, "car").availableCents).toBe(25_000);
    expect(target(status("2026-04-02", versions, [], adjustments), "food").availableCents).toBe(50_000);
  });
});

describe("recentHistory", () => {
  const history = (on: string, versions: TargetVersion[], lines: SpendLine[]) => recentHistory({ on, versions, lines, categories: cats });

  it("averages the last three full months, leaving out the current one", () => {
    const h = history("2026-05-14", [], [
      spend("2026-01-20", "car", 999), // before the window
      spend("2026-02-03", "car", 100),
      spend("2026-03-03", "car", 200),
      spend("2026-04-03", "car", 300),
      spend("2026-05-02", "car", 5_000), // this month: left out
    ]).get("car")!;
    expect(h.months.map((m) => [m.month, m.spentCents])).toEqual([
      ["2026-02-01", 10_000],
      ["2026-03-01", 20_000],
      ["2026-04-01", 30_000],
    ]);
    expect(h.averageCents).toBe(20_000);
  });

  it("nets refunds, counts an empty month inside the history as $0, and starts a new category at its first month", () => {
    const h = history("2026-05-14", [], [
      spend("2026-02-03", "gifts", 80),
      spend("2026-02-10", "gifts", -20), // a refund
      spend("2026-04-03", "gifts", 30),
      spend("2026-03-09", "car", 90), // first seen in March
    ]);
    expect(h.get("gifts")!.months.map((m) => m.spentCents)).toEqual([6_000, 0, 3_000]);
    expect(h.get("gifts")!.averageCents).toBe(3_000);
    expect(h.get("car")!.months).toHaveLength(2);
    expect(h.get("car")!.averageCents).toBe(4_500);
  });

  it("has no history, not $0, for a category with nothing in the window", () => {
    expect(history("2026-05-14", [], [spend("2025-12-01", "car", 50)]).get("car")).toMatchObject({ averageCents: null, months: [] });
  });

  it("covers what a target would cover today: a parent takes children without their own, the buffer the rest", () => {
    const lines = [spend("2026-04-02", "groceries", 100), spend("2026-04-03", "dining", 40), spend("2026-04-04", "car", 60)];
    // Dining has its own target, so Food covers only groceries.
    const h = history("2026-05-14", [v({ categoryId: "dining" }), v({ categoryId: null })], lines);
    expect(h.get("food")!.averageCents).toBe(10_000);
    expect(h.get("dining")!.averageCents).toBe(4_000);
    expect(h.get(BUFFER)!.averageCents).toBe(16_000); // groceries and car draw from it today
    expect(h.get("paycheck")).toBeUndefined();
  });

  it("counts months over today's monthly target, even one set this month", () => {
    const versions = [v({ categoryId: "car", amountCents: 15_000 }), v({ categoryId: "car", effectiveFrom: "2026-05-01", amountCents: 15_000 })];
    const h = history("2026-05-14", versions, [spend("2026-02-03", "car", 160), spend("2026-03-03", "car", 140), spend("2026-04-03", "car", 200)]);
    expect(h.get("car")).toMatchObject({ overMonths: 2, comparedMonths: 3 });
    expect(history("2026-05-14", [v({ categoryId: "car", effectiveFrom: "2026-05-01", amountCents: 15_000 })], [spend("2026-02-03", "car", 160)]).get("car")).toMatchObject({
      overMonths: 1,
      comparedMonths: 3, // February, then two months at $0
    });
    // No over count for an annual target, or with no target at all.
    expect(history("2026-05-14", [v({ categoryId: "car", periodMonths: 12 })], [spend("2026-02-03", "car", 160)]).get("car")!.overMonths).toBeNull();
    expect(history("2026-05-14", [], [spend("2026-02-03", "car", 160)]).get("car")!.overMonths).toBeNull();
  });
});
