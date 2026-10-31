import { describe, expect, it } from "vitest";
import { periodBreakdown } from "./breakdown";

// Invented lines, signed like transactions: −$50 is spent, +$10 a refund.
const line = (amountCents: number, categoryName: string, merchant: string | null, description = "CARD PURCHASE") => ({ amountCents, categoryName, merchant, description });

describe("periodBreakdown (#174)", () => {
  const lines = [
    line(-4_500, "Dining", "Lantern Noodle Bar"),
    line(-12_000, "Groceries", "Quillfield Market"),
    line(-3_200, "Dining", "Lantern Noodle Bar"),
    line(1_000, "Groceries", "Quillfield Market"),
    line(-800, "Coffee", null, "CORNER BEAN CAFE"),
  ];

  it("adds up to the period's spent figure, by category and by merchant", () => {
    const b = periodBreakdown(lines);
    expect(b.spentCents).toBe(19_500);
    expect(b.byCategory.reduce((s, c) => s + c.spentCents, 0)).toBe(b.spentCents);
    expect(b.byMerchant.reduce((s, c) => s + c.spentCents, 0)).toBe(b.spentCents);
  });

  it("ranks the biggest first, counting a refund against its group", () => {
    const b = periodBreakdown(lines);
    expect(b.byCategory).toEqual([
      { name: "Groceries", spentCents: 11_000, lines: 2 },
      { name: "Dining", spentCents: 7_700, lines: 2 },
      { name: "Coffee", spentCents: 800, lines: 1 },
    ]);
    // No merchant name: the bank's description stands in.
    expect(b.byMerchant.at(-1)).toEqual({ name: "CORNER BEAN CAFE", spentCents: 800, lines: 1 });
  });
});
