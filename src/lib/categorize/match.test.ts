import { describe, expect, it } from "vitest";
import { categoryOptions, filterOptions } from "@/lib/categorize/labels";
import { firstMatchingRule, merchantMemory, ruleMatches, type RuleLike } from "@/lib/categorize/match";

const rule = (overrides: Partial<RuleLike> = {}): RuleLike => ({
  id: "r",
  matchField: "merchant",
  matchType: "equals",
  pattern: "Corner Bean Cafe",
  accountId: null,
  minAmountCents: null,
  maxAmountCents: null,
  categoryId: "coffee",
  enabled: true,
  ...overrides,
});
const txn = { accountId: "a1", amountCents: -650, description: "SQ *CORNER BEAN CAFE #12", merchant: "Corner Bean Cafe" };

describe("ruleMatches", () => {
  it("matches case-insensitively on merchant or description", () => {
    expect(ruleMatches(rule({ pattern: "corner bean cafe" }), txn)).toBe(true);
    expect(ruleMatches(rule({ matchField: "description", matchType: "contains", pattern: "corner bean" }), txn)).toBe(true);
    expect(ruleMatches(rule({ matchField: "description", matchType: "starts_with", pattern: "sq *" }), txn)).toBe(true);
    expect(ruleMatches(rule({ matchType: "equals", pattern: "Corner Bean" }), txn)).toBe(false);
  });

  it("respects account and amount limits, on absolute value", () => {
    expect(ruleMatches(rule({ accountId: "a2" }), txn)).toBe(false);
    expect(ruleMatches(rule({ minAmountCents: 500 }), txn)).toBe(true);
    expect(ruleMatches(rule({ minAmountCents: 1000 }), txn)).toBe(false);
    expect(ruleMatches(rule({ maxAmountCents: 600 }), txn)).toBe(false);
  });

  it("ignores disabled rules, and handles a missing merchant", () => {
    expect(ruleMatches(rule({ enabled: false }), txn)).toBe(false);
    expect(ruleMatches(rule(), { ...txn, merchant: null })).toBe(false);
  });

  it("first matching rule wins, in the given order", () => {
    const rules = [rule({ id: "a", pattern: "nope" }), rule({ id: "b" }), rule({ id: "c" })];
    expect(firstMatchingRule(rules, txn)?.id).toBe("b");
  });
});

describe("merchantMemory", () => {
  it("applies when history is consistent, even after one categorization", () => {
    expect(merchantMemory(["coffee"])).toEqual({ kind: "apply", categoryId: "coffee" });
    expect(merchantMemory(["coffee", "coffee", "coffee"])).toEqual({ kind: "apply", categoryId: "coffee" });
  });

  it("only suggests when recent history is mixed, preferring the most common then most recent", () => {
    expect(merchantMemory(["gifts", "groceries", "groceries"])).toEqual({ kind: "suggest", categoryId: "groceries" });
    expect(merchantMemory(["gifts", "groceries"])).toEqual({ kind: "suggest", categoryId: "gifts" });
  });

  it("looks only at the most recent five", () => {
    expect(merchantMemory(["a", "a", "a", "a", "a", "b", "b"])).toEqual({ kind: "apply", categoryId: "a" });
  });

  it("has nothing to say without history", () => {
    expect(merchantMemory([])).toEqual({ kind: "none" });
  });
});

describe("category labels", () => {
  const rows = [
    { id: "f", name: "Food", kind: "expense", parentId: null },
    { id: "g", name: "Groceries", kind: "expense", parentId: "f" },
    { id: "d", name: "Dining", kind: "expense", parentId: "f" },
    { id: "t", name: "Transport", kind: "expense", parentId: null },
  ];

  it("orders parents alphabetically with their children under them", () => {
    expect(categoryOptions(rows).map((o) => o.label)).toEqual(["Food", "Food › Dining", "Food › Groceries", "Transport"]);
  });

  it("filters with leaf-prefix matches first", () => {
    expect(filterOptions(categoryOptions(rows), "gro").map((o) => o.id)).toEqual(["g"]);
    expect(filterOptions(categoryOptions(rows), "food").map((o) => o.id)).toEqual(["f", "d", "g"]);
    expect(filterOptions(categoryOptions(rows), "zzz")).toEqual([]);
  });
});
