import { describe, expect, it } from "vitest";
import type { Row } from "./analyze";
import { donut, donutRows } from "./donut";

// Made-up rows, ranked as the table ranks them.
const row = (key: string, spentCents: number, children: Row[] = []): Row => ({ key, label: key, spentCents, prevCents: 0, children });

describe("donut", () => {
  it("puts categories inside and their subcategories outside, each ring adding up to the total", () => {
    const rows = [row("Food", 6000, [row("Groceries", 4000), row("Dining", 2000)]), row("Rent", 4000)];
    const d = donut(donutRows(rows, "category", () => ""), "category");
    expect(d.totalCents).toBe(10000);
    expect(d.inner.map((s) => [s.label, s.from, s.to])).toEqual([
      ["Food", 0, 0.6],
      ["Rent", 0.6, 1],
    ]);
    // A category with no subcategories is its own outer slice.
    expect(d.outer!.map((s) => [s.label, s.parent!.label])).toEqual([
      ["Groceries", "Food"],
      ["Dining", "Food"],
      ["Rent", "Rent"],
    ]);
    expect(d.outer!.at(-1)!.to).toBe(1);
  });

  it("merges slices too small to read into Other, and never makes an Other of one", () => {
    const rows = [row("A", 9700), row("B", 100), row("C", 100), row("D", 100)];
    const d = donut(donutRows(rows, "merchant", () => ""), "merchant");
    expect(d.inner.map((s) => [s.label, s.cents])).toEqual([
      ["A", 9700],
      ["Other", 300],
    ]);
    expect(d.outer).toBeNull();
    const one = donut(donutRows([row("A", 9900), row("B", 100)], "merchant", () => ""), "merchant");
    expect(one.inner.map((s) => s.label)).toEqual(["A", "B"]);
  });

  it("groups accounts by kind, and leaves out a row refunds took below zero, saying so", () => {
    const kinds: Record<string, string> = { visa: "Credit card", amex: "Credit card", chk: "Checking" };
    const rows = [row("visa", 5000), row("chk", 3000), row("amex", 2000), row("refunds", -500)];
    const d = donut(donutRows(rows.slice(0, 3), "account", (id) => kinds[id]), "account");
    expect(d.inner.map((s) => [s.label, s.cents])).toEqual([
      ["Credit card", 7000],
      ["Checking", 3000],
    ]);
    expect(d.outer!.map((s) => s.label)).toEqual(["visa", "amex", "chk"]);
    const withRefund = donut(donutRows(rows, "merchant", () => ""), "merchant");
    expect(withRefund.negative).toEqual([{ label: "refunds", cents: -500 }]);
    expect(withRefund.totalCents).toBe(10000);
  });

  it("fits an outer ring to its slice when a subcategory nets negative", () => {
    const rows = [row("Food", 3000, [row("Groceries", 4000), row("Returns", -1000)]), row("Rent", 3000)];
    const d = donut(donutRows(rows, "category", () => ""), "category");
    expect(d.outer!.map((s) => [s.label, s.to])).toEqual([
      ["Groceries", 0.5],
      ["Rent", 1],
    ]);
  });
});
