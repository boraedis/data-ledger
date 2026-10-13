import { like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { dailySpend, dailySpendQuery, recurringCharges } from "@/lib/bridge/v1";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listRecurring } from "@/operations/recurring";
import { execute } from "@/operations/runtime";
import { spendingLines } from "@/operations/transactions";

// The bridge against the synthetic seed. What matters most is what *isn't*
// in a response, so the exact key sets are asserted, not just a few values.

let db: Db;
const on = "2026-06-30";
beforeAll(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date(on) });
  // The seed leaves categorizing to the pipeline; file a few merchants
  // directly, including income, which must not show up as spend.
  const cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  await db.update(transactions).set({ categoryId: cat.Groceries }).where(like(transactions.description, "QUILLFIELD%"));
  await db.update(transactions).set({ categoryId: cat.Coffee }).where(like(transactions.description, "CORNER BEAN%"));
  await db.update(transactions).set({ categoryId: cat.Paycheck }).where(like(transactions.description, "ACME WIDGETS%"));
});

describe("daily spend", () => {
  it("returns only the documented fields, and the same net spend Budgets counts", async () => {
    const days = await dailySpend(db, { from: "2026-06-01", to: "2026-06-30" });
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      expect(Object.keys(day).sort()).toEqual(["category", "categoryId", "date", "parentCategory", "spentCents"]);
      expect(day.date >= "2026-06-01" && day.date <= "2026-06-30").toBe(true);
      expect(day.spentCents).not.toBe(0);
    }

    const kinds = new Map((await db.select().from(categories)).map((c) => [c.id, c.kind]));
    const lines = await spendingLines.run(db, { from: "2026-06-01", to: "2026-06-30", budgetOnly: true, gross: false });
    const expected = -lines.filter((l) => kinds.get(l.categoryId) === "expense").reduce((sum, l) => sum + l.amountCents, 0);
    expect(days.reduce((sum, d) => sum + d.spentCents, 0)).toBe(expected);
    expect(days.every((d) => kinds.get(d.categoryId) === "expense")).toBe(true);
    expect(new Set(days.map((d) => d.category))).toEqual(new Set(["Groceries", "Coffee"]));
  });

  it("validates the range", () => {
    expect(dailySpendQuery.safeParse({ from: "2026-06-01", to: "2026-06-30" }).success).toBe(true);
    expect(dailySpendQuery.safeParse({ from: "2026-06-30", to: "2026-06-01" }).success).toBe(false);
    expect(dailySpendQuery.safeParse({ from: "2024-01-01", to: "2026-06-30" }).success).toBe(false);
    expect(dailySpendQuery.safeParse({ from: "June", to: "2026-06-30" }).success).toBe(false);
    expect(dailySpendQuery.safeParse({ from: null, to: null }).success).toBe(false);
  });
});

describe("recurring charges", () => {
  it("returns only the documented fields, without accounts, and leaves dismissed ones out", async () => {
    const before = await recurringCharges(db, on);
    expect(before.length).toBeGreaterThan(0);
    for (const charge of before) {
      expect(Object.keys(charge).sort()).toEqual([
        "active",
        "annualizedCents",
        "cadence",
        "lastOn",
        "latestCents",
        "merchant",
        "nextExpectedOn",
        "status",
        "typicalCents",
        "variable",
      ]);
      expect(["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"]).toContain(charge.cadence);
    }

    const [first] = await listRecurring.run(db, { on });
    await execute(db, {
      operation: "recurring.setStatus",
      input: { merchant: first.merchant, accountId: first.accountId, status: "dismissed" },
      actor: "user",
      reason: "Not a bill",
    });
    const after = await recurringCharges(db, on);
    expect(after).toHaveLength(before.length - 1);
  });
});
