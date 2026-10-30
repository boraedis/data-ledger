import { describe, expect, it } from "vitest";
import { targetList } from "@/lib/budgets/target-list";

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
