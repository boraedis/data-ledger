import { and, eq, isNull, like } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { categoryChoices } from "@/operations/choices";
import { execute } from "@/operations/runtime";

// Choices for the quick-file screen against the synthetic seed.

let db: Db;
let cat: Record<string, string>;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
});

const one = async (pattern: string) =>
  (await db.select().from(transactions).where(and(like(transactions.description, pattern), isNull(transactions.categoryId))).limit(1))[0];

it("offers the merchant's usual category first, and a matching rule ahead of it", async () => {
  // History: most Corner Bean visits filed as Coffee, one as Dining.
  const visits = await db.select().from(transactions).where(like(transactions.description, "CORNER BEAN%")).limit(6);
  for (const [i, v] of visits.entries()) await db.update(transactions).set({ categoryId: i === 0 ? cat.Dining : cat.Coffee }).where(eq(transactions.id, v.id));
  const coffee = await one("CORNER BEAN%");

  const choices = await categoryChoices.run(db, { transactionId: coffee.id });
  expect(choices.slice(0, 2)).toEqual([
    { categoryId: cat.Coffee, source: "memory" },
    { categoryId: cat.Dining, source: "memory" },
  ]);

  await execute(db, {
    operation: "rules.create",
    actor: "user",
    reason: "Test",
    input: { matchField: "description", matchType: "starts_with", pattern: "CORNER BEAN", categoryId: cat.Groceries },
  });
  expect((await categoryChoices.run(db, { transactionId: coffee.id }))[0]).toEqual({ categoryId: cat.Groceries, source: "rule" });
});

it("never offers income for money out, and falls back to recent categories for a new merchant", async () => {
  await db.update(transactions).set({ categoryId: cat.Paycheck }).where(like(transactions.description, "ACME WIDGETS%"));
  await db.update(transactions).set({ categoryId: cat.Groceries }).where(like(transactions.description, "QUILLFIELD%"));
  const ride = await one("ZIPRIDE%");
  const choices = await categoryChoices.run(db, { transactionId: ride.id });
  expect(choices.length).toBeGreaterThan(0);
  expect(choices.every((c) => c.source === "recent" && c.categoryId !== cat.Paycheck)).toBe(true);
  expect(choices.map((c) => c.categoryId)).toContain(cat.Groceries);
});
