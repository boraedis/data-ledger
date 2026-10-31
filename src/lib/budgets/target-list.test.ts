import { describe, expect, it } from "vitest";
import { targetList, versionEditFrom, versionSpans } from "@/lib/budgets/target-list";

const v = (categoryId: string | null, name: string, effectiveFrom: string, amountCents: number | null) => ({
  categoryId,
  name,
  effectiveFrom,
  amountCents,
  periodMonths: 1,
  rollover: false,
  sinkingFund: false,
});

describe("targetList (#145)", () => {
  const versions = [
    v("dining", "Dining", "2026-01-01", 40000),
    v("dining", "Dining", "2026-06-01", 45000),
    v(null, "Everything else", "2026-03-01", 80000),
    v("hobbies", "Hobbies", "2026-02-01", 10000),
    v("hobbies", "Hobbies", "2026-05-01", null),
    v("groceries", "Groceries", "2026-04-01", 60000),
  ];

  it("lists what's in effect today, the buffer first, with the current amount and its changes", () => {
    const { active } = targetList(versions, "2026-10-15");
    expect(active.map((t) => t.name)).toEqual(["Everything else", "Dining", "Groceries"]);
    expect(active[1]).toMatchObject({ amountCents: 45000, since: "2026-06-01", changes: 1 });
  });

  it("keeps an ended target apart, with its last amount", () => {
    const { ended } = targetList(versions, "2026-10-15");
    expect(ended).toEqual([{ categoryId: "hobbies", name: "Hobbies", endedOn: "2026-05-01", lastAmountCents: 10000 }]);
  });

  it("judges by today: earlier, Hobbies was still in effect and Groceries hadn't started", () => {
    const { active, ended } = targetList(versions, "2026-03-15");
    expect(active.map((t) => t.name)).toEqual(["Everything else", "Dining", "Hobbies"]);
    expect(ended).toEqual([]);
  });
});

describe("versionSpans (#174)", () => {
  const w = (categoryId: string | null, effectiveFrom: string, amountCents: number | null) => ({
    categoryId, effectiveFrom, amountCents, periodMonths: 1, anchorOn: effectiveFrom, rollover: false, sinkingFund: false,
  });

  it("lists one target's versions oldest first, each until the month before the next, an ending marked", () => {
    const spans = versionSpans(
      [w("dining", "2026-06-01", 45_000), w("groceries", "2026-02-01", 60_000), w("dining", "2026-01-01", 40_000), w("dining", "2026-09-01", null)],
      "dining",
    );
    expect(spans.map((s) => [s.effectiveFrom, s.until, s.amountCents])).toEqual([
      ["2026-01-01", "2026-05-01", 40_000],
      ["2026-06-01", "2026-08-01", 45_000],
      ["2026-09-01", null, null],
    ]);
  });

  it("leaves the version in effect open-ended, the buffer by null", () => {
    expect(versionSpans([w(null, "2026-03-01", 80_000)], null)).toMatchObject([{ effectiveFrom: "2026-03-01", until: null, amountCents: 80_000 }]);
  });
});

describe("versionEditFrom (#174)", () => {
  const span = (effectiveFrom: string, until: string | null, periodMonths = 1, anchorOn = effectiveFrom) => ({ effectiveFrom, until, periodMonths, anchorOn });

  it("changes a version from its own start when the data reaches back that far", () => {
    expect(versionEditFrom(span("2026-03-01", "2026-06-01"), "2025-11", "2026-10")).toBe("2026-03");
  });

  it("starts from the first month with transactions when the version is older", () => {
    expect(versionEditFrom(span("2026-01-01", null), "2026-05", "2026-10")).toBe("2026-05");
  });

  it("keeps a multi-month target to a period start: the next quarter from then", () => {
    // Quarters from January: data from May, so July.
    expect(versionEditFrom(span("2026-01-01", null, 3, "2026-01-01"), "2026-05", "2026-10")).toBe("2026-07");
    // Data from April is already a quarter's start.
    expect(versionEditFrom(span("2026-01-01", null, 3, "2026-01-01"), "2026-04", "2026-10")).toBe("2026-04");
  });

  it("can't change an annual target whose only period started before the data, or one that ended before it", () => {
    expect(versionEditFrom(span("2026-01-01", null, 12, "2026-01-01"), "2026-05", "2026-10")).toBeNull();
    expect(versionEditFrom(span("2025-06-01", "2025-12-01"), "2026-05", "2026-10")).toBeNull();
    expect(versionEditFrom(span("2026-01-01", null), null, "2026-10")).toBeNull();
  });
});
