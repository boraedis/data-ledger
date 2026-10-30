import { describe, expect, it } from "vitest";
import { budgetOverview, targetAnchor } from "./overview";

// Made-up targets for October 2026: two monthly, the buffer, and an annual one.
const t = (categoryId: string | null, name: string, start: string, end: string, spentCents: number, availableCents: number) => ({
  categoryId,
  name,
  start,
  end,
  spentCents,
  availableCents,
  remainingCents: availableCents - spentCents,
});
const targets = [
  t(null, "Everything else (buffer)", "2026-10-01", "2026-10-31", 212_908, 100_000),
  t("dining", "Dining", "2026-10-01", "2026-10-31", 76_041, 20_000),
  t("groceries", "Groceries", "2026-10-01", "2026-10-31", 32_468, 45_000),
  t("car", "Car", "2026-01-01", "2026-12-31", 18_650, 120_000),
];

describe("budgetOverview (#122)", () => {
  it("lists every target with its card's figures, linking to its card", () => {
    const o = budgetOverview(targets);
    expect([...o.monthly, ...o.longer]).toHaveLength(targets.length);
    expect(o.monthly[1]).toMatchObject({ name: "Dining", spentCents: 76_041, availableCents: 20_000, remainingCents: -56_041, anchor: "target-dining" });
    expect(targetAnchor(null)).toBe("target-buffer");
  });

  it("totals the targets measured on this month, and keeps a year's figures out of it", () => {
    const o = budgetOverview(targets);
    expect(o.longer.map((r) => r.name)).toEqual(["Car"]);
    expect(o.total).toEqual({ spentCents: 212_908 + 76_041 + 32_468, availableCents: 165_000, remainingCents: 165_000 - 321_417 });
    expect(budgetOverview([targets[3]]).total).toBeNull();
  });
});
