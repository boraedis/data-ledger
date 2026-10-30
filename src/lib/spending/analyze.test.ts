import { describe, expect, it } from "vitest";
import { findRow, lineInRow, parsePeriod, rowTransactions, spendingRows, type CategoryInfo, type Lookup, type SpendLine } from "@/lib/spending/analyze";

// Invented categories, accounts and merchants. amountCents < 0 = money out.

const cats: CategoryInfo[] = [
  { id: "food", name: "Food", kind: "expense", parentId: null },
  { id: "dining", name: "Dining", kind: "expense", parentId: "food" },
  { id: "groceries", name: "Groceries", kind: "expense", parentId: "food" },
  { id: "transport", name: "Transport", kind: "expense", parentId: null },
  { id: "salary", name: "Salary", kind: "income", parentId: null },
  { id: "xfer", name: "Card payments", kind: "transfer", parentId: null },
];
const lookup: Lookup = { categories: new Map(cats.map((c) => [c.id, c])), accountNames: new Map([["card", "Rewards Card"], ["checking", "Everyday Checking"]]) };

let n = 0;
const line = (categoryId: string, cents: number, extra: Partial<SpendLine> = {}): SpendLine => ({
  transactionId: `t${++n}`,
  date: "2026-09-10",
  amountCents: cents,
  categoryId,
  accountId: "card",
  merchant: "Lumen Bistro",
  ...extra,
});

describe("parsePeriod", () => {
  const today = "2026-10-28";

  it("defaults to this month, compared with last month up to the same day", () => {
    expect(parsePeriod({}, today)).toMatchObject({
      kind: "month",
      from: "2026-10-01",
      to: "2026-10-31",
      label: "October 2026",
      prev: { from: "2026-09-01", to: "2026-09-28", label: "Sep 1–28" },
      earlier: { month: "2026-09" },
      later: null,
    });
  });

  it("compares a past month with the whole month before, across a year end", () => {
    expect(parsePeriod({ month: "2026-01" }, today)).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-31",
      prev: { from: "2025-12-01", to: "2025-12-31", label: "December" },
      earlier: { month: "2025-12" },
      later: { month: "2026-02" },
    });
  });

  it("compares this year so far with last year to the same day", () => {
    expect(parsePeriod({ year: "2026" }, today)).toMatchObject({
      kind: "year",
      from: "2026-01-01",
      to: "2026-12-31",
      prev: { from: "2025-01-01", to: "2025-10-28", label: "2025 to Oct 28" },
      later: null,
    });
    expect(parsePeriod({ year: "2025" }, today)).toMatchObject({ prev: { from: "2024-01-01", to: "2024-12-31", label: "2024" }, later: { year: "2026" } });
  });

  it("compares a custom range with the same number of days just before it", () => {
    expect(parsePeriod({ from: "2026-09-10", to: "2026-09-19" }, today)).toMatchObject({
      kind: "range",
      prev: { from: "2026-08-31", to: "2026-09-09" },
      earlier: { from: "2026-08-31", to: "2026-09-09" },
      later: { from: "2026-09-20", to: "2026-09-29" },
    });
    // Backwards or malformed: the default month.
    expect(parsePeriod({ from: "2026-09-19", to: "2026-09-10" }, today).kind).toBe("month");
    expect(parsePeriod({ month: "2026-13x" }, today).from).toBe("2026-10-01");
  });
});

describe("spendingRows", () => {
  const current = [
    line("dining", -3_000),
    line("dining", -2_000),
    line("dining", 500), // a refund offsets
    line("groceries", -5_000, { accountId: "checking", merchant: "Quillfield Market" }),
    line("food", -1_000, { merchant: null }),
    line("transport", -1_500, { merchant: "Zipride" }),
    line("salary", 300_000), // income: never spending
    line("xfer", -50_000), // a transfer: never spending
  ];
  const previous = [line("dining", -4_000), line("transport", -1_500, { merchant: "Zipride" })];

  it("groups by category, parents holding their subcategories, ranked by spend", () => {
    const { rows, totalCents, prevTotalCents } = spendingRows(current, previous, "category", lookup);
    expect(totalCents).toBe(12_000);
    expect(prevTotalCents).toBe(5_500);
    expect(rows.map((r) => [r.label, r.spentCents, r.prevCents])).toEqual([
      ["Food", 10_500, 4_000],
      ["Transport", 1_500, 1_500],
    ]);
    expect(rows[0].children.map((c) => [c.label, c.spentCents, c.prevCents])).toEqual([
      ["Groceries", 5_000, 0],
      ["Dining", 4_500, 4_000],
      ["Food, not in a subcategory", 1_000, 0],
    ]);
    // Nothing to break down under a category with no subcategories.
    expect(rows[1].children).toEqual([]);
  });

  it("groups by merchant and by account, by name only", () => {
    const merchants = spendingRows(current, previous, "merchant", lookup).rows;
    expect(merchants.map((r) => [r.label, r.spentCents])).toEqual([
      ["Quillfield Market", 5_000],
      ["Lumen Bistro", 4_500],
      ["Zipride", 1_500],
      ["No merchant", 1_000],
    ]);
    const accounts = spendingRows(current, previous, "account", lookup).rows;
    expect(accounts.map((r) => [r.key, r.label, r.spentCents, r.prevCents])).toEqual([
      ["card", "Rewards Card", 7_000, 5_500],
      ["checking", "Everyday Checking", 5_000, 0],
    ]);
    expect(Object.keys(accounts[0]).sort()).toEqual(["children", "key", "label", "prevCents", "spentCents"]);
  });

  it("keeps a row that had spending only in the earlier period", () => {
    const { rows } = spendingRows([line("dining", -1_000)], [line("transport", -2_000)], "category", lookup);
    expect(rows.map((r) => [r.label, r.spentCents, r.prevCents])).toEqual([
      ["Food", 1_000, 0],
      ["Transport", 0, 2_000],
    ]);
  });
});

describe("the transactions behind a row", () => {
  it("sums a split transaction's parts within the row, and finds subcategory rows", () => {
    const split = [line("dining", -1_200, { transactionId: "s1", date: "2026-09-12" }), line("groceries", -800, { transactionId: "s1", date: "2026-09-12" })];
    const lines = [...split, line("dining", -2_500, { transactionId: "d1", date: "2026-09-03" }), line("salary", 9_000, { transactionId: "p1" })];
    expect(rowTransactions(lines, "food", "category", lookup).map((t) => [t.transactionId, t.spentCents])).toEqual([
      ["s1", 2_000],
      ["d1", 2_500],
    ]);
    expect(rowTransactions(lines, "dining", "category", lookup).map((t) => [t.transactionId, t.spentCents])).toEqual([
      ["s1", 1_200],
      ["d1", 2_500],
    ]);
    expect(lineInRow(lines.at(-1)!, "salary", "category", lookup)).toBe(false);
    const { rows } = spendingRows(lines, [], "category", lookup);
    expect(findRow(rows, "groceries")?.label).toBe("Groceries");
    expect(findRow(rows, "nope")).toBeUndefined();
  });
});
