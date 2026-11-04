import { describe, expect, it } from "vitest";
import { filterMerchants, merchantOverview, spendByMonth, type Line } from "./overview";

// Invented merchants, categories and amounts.
const cats: Record<string, { name: string; kind: string }> = {
  food: { name: "Dining", kind: "expense" },
  groc: { name: "Groceries", kind: "expense" },
  back: { name: "Refunds in", kind: "income" },
};
const merchants = [
  { id: "m1", name: "Lumen Bistro", typeId: "t-rest", type: "Restaurant", aliases: ["Lumen Bistro", "Lumen Bistro Downtown"] },
  { id: "m2", name: "Quillfield Market", typeId: null, type: null, aliases: ["Quillfield Market"] },
  { id: "m3", name: "Never Seen", typeId: null, type: null, aliases: ["Never Seen"] },
];
const txns = [
  { id: "a", merchantId: "m1", postedOn: "2026-03-02" },
  { id: "b", merchantId: "m1", postedOn: "2026-04-10" },
  { id: "c", merchantId: "m1", postedOn: "2026-04-12" },
  { id: "d", merchantId: "m2", postedOn: "2026-02-01" },
];
const lines: Line[] = [
  { transactionId: "a", date: "2026-03-02", amountCents: -4000, categoryId: "food" },
  { transactionId: "b", date: "2026-04-10", amountCents: -2000, categoryId: "food" },
  { transactionId: "c", date: "2026-04-12", amountCents: 500, categoryId: "food" }, // a refund
  { transactionId: "d", date: "2026-02-01", amountCents: -3000, categoryId: "groc" },
  { transactionId: "d", date: "2026-02-01", amountCents: -1000, categoryId: "food" }, // a split
];
const rows = merchantOverview({ merchants, txns, lines, category: (id) => cats[id], recurring: new Set(["Lumen Bistro Downtown"]) });

describe("merchantOverview", () => {
  it("adds up net spend, counts transactions, finds the last seen, the usual category and whether it recurs", () => {
    expect(rows[0]).toMatchObject({ spentCents: 5500, transactions: 3, lastSeen: "2026-04-12", usualCategory: { name: "Dining" }, recurs: true });
    expect(rows[1]).toMatchObject({ spentCents: 4000, transactions: 1, recurs: false });
    expect(rows[2]).toMatchObject({ spentCents: 0, transactions: 0, lastSeen: null, usualCategory: null });
  });
});

describe("filterMerchants", () => {
  it("searches names and aliases, filters by type and sorts", () => {
    expect(filterMerchants(rows, { q: "downtown", type: null, sort: "spent" }).map((r) => r.id)).toEqual(["m1"]);
    expect(filterMerchants(rows, { q: "", type: "none", sort: "spent" }).map((r) => r.id)).toEqual(["m2", "m3"]);
    expect(filterMerchants(rows, { q: "", type: "t-rest", sort: "spent" }).map((r) => r.id)).toEqual(["m1"]);
    expect(filterMerchants(rows, { q: "", type: null, sort: "last" }).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(filterMerchants(rows, { q: "", type: null, sort: "name" }).map((r) => r.name)).toEqual(["Lumen Bistro", "Never Seen", "Quillfield Market"]);
  });
});

describe("spendByMonth", () => {
  it("puts each month's net spend in its month, empty months at zero", () => {
    const mine = lines.filter((l) => ["a", "b", "c"].includes(l.transactionId));
    expect(spendByMonth(mine, ["2026-02", "2026-03", "2026-04"], (id) => cats[id]?.kind === "expense")).toEqual([
      { month: "2026-02", spentCents: 0 },
      { month: "2026-03", spentCents: 4000 },
      { month: "2026-04", spentCents: 1500 },
    ]);
  });
});
