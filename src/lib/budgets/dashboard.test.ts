import { describe, expect, it } from "vitest";
import { budgetDashboard } from "@/lib/budgets/dashboard";
import { sumCells } from "@/lib/budgets/year";

const cell = (spentCents: number, targetCents: number | null) => ({ spentCents, targetCents });

describe("budgetDashboard (#146)", () => {
  it("totals the month and names the biggest overspend", () => {
    const d = budgetDashboard([
      { categoryId: "dining", name: "Dining", months: [cell(47500, 40000)] },
      { categoryId: "groceries", name: "Groceries", months: [cell(52000, 60000)] },
    ]);
    expect(d.month).toEqual({ spentCents: 99500, targetCents: 100000, months: 2 });
    expect(d.monthOver).toEqual([{ categoryId: "dining", name: "Dining", spentCents: 47500, targetCents: 40000, overCents: 7500 }]);
  });

  const rows = [
    { categoryId: null, name: "Everything else", months: [cell(90000, 80000), cell(70000, 80000), cell(85000, 80000)] },
    // No target in January: that month counts on neither side.
    { categoryId: "dining", name: "Dining", months: [cell(30000, null), cell(45000, 40000), cell(41000, 40000)] },
    { categoryId: "coffee", name: "Coffee", months: [cell(8000, 6000), cell(7000, 6000), cell(9000, 6000)] },
    { categoryId: "car", name: "Car", months: [cell(0, 10000), cell(0, 10000), cell(0, 10000)] },
  ];

  it("makes the year the sum of its months", () => {
    const d = budgetDashboard(rows);
    const columns = [0, 1, 2].map((i) => sumCells(rows.map((r) => r.months[i]))!);
    expect(d.year!.spentCents).toBe(columns.reduce((s, c) => s + c.spentCents, 0));
    expect(d.year!.targetCents).toBe(columns.reduce((s, c) => s + c.targetCents, 0));
    expect(d.year).toEqual({ spentCents: 355000, targetCents: 368000, months: 11 });
  });

  it("ranks overspends for the month and the year separately, top three", () => {
    const d = budgetDashboard(rows);
    expect(d.monthOver.map((o) => [o.name, o.overCents])).toEqual([
      ["Everything else", 5000],
      ["Coffee", 3000],
      ["Dining", 1000],
    ]);
    // Dining's year is February and March only ($860 against $800), tied
    // with Coffee's $60 over; ties go by name.
    expect(d.yearOver.map((o) => [o.name, o.overCents])).toEqual([
      ["Coffee", 6000],
      ["Dining", 6000],
      ["Everything else", 5000],
    ]);
  });

  it("counts budget moved between targets in its month, leaving the total alone", () => {
    const d = budgetDashboard([
      { categoryId: "dining", name: "Dining", months: [{ ...cell(76000, 15000), movedCents: 5000 }] },
      { categoryId: "groceries", name: "Groceries", months: [{ ...cell(32500, 50000), movedCents: -5000 }] },
    ]);
    expect(d.monthOver).toEqual([{ categoryId: "dining", name: "Dining", spentCents: 76000, targetCents: 20000, overCents: 56000 }]);
    expect(d.month).toEqual({ spentCents: 108500, targetCents: 65000, months: 2 });
  });

  it("has no totals for a month without targets", () => {
    const d = budgetDashboard([{ categoryId: "dining", name: "Dining", months: [cell(40000, 40000), cell(12000, null)] }]);
    expect(d.month).toBeNull();
    expect(d.monthOver).toEqual([]);
    expect(d.year).toEqual({ spentCents: 40000, targetCents: 40000, months: 1 });
    expect(budgetDashboard([]).month).toBeNull();
  });
});
