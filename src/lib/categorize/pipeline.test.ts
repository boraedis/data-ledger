import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillMerchantsIfNeeded, runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listInbox } from "@/operations/transactions";
import { execute, read, undoCommand } from "@/operations/runtime";

// The pipeline end to end on PGlite over the synthetic seed: rules, then
// merchant memory, then the inbox. All data invented.

let db: Db;
let cat: Record<string, string>;

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" });

async function txnsFor(merchant: string) {
  return db.select().from(transactions).where(eq(transactions.merchant, merchant));
}

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
});

describe("runCategorization", () => {
  it("leaves everything in the inbox with no rules and no history", async () => {
    const result = await runCategorization(db);
    expect(result.byRules + result.byMemory).toBe(0);
    expect(result.remaining).toBeGreaterThan(200);
    expect(await db.select().from(commandLog)).toHaveLength(0);
  });

  it("applies rules as one logged, undoable command per rule", async () => {
    await user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Corner Bean Cafe", categoryId: cat.Coffee });
    const result = await runCategorization(db);
    const coffee = await txnsFor("Corner Bean Cafe");
    expect(coffee.length).toBeGreaterThan(20);
    expect(result.byRules).toBe(coffee.length);
    expect(coffee.every((t) => t.categoryId === cat.Coffee)).toBe(true);

    const entries = await db.select().from(commandLog).where(eq(commandLog.operation, "transactions.applyCategories"));
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toMatch(/^rule:/);
    expect(entries[0].reason).toBe('Rule: merchant is "Corner Bean Cafe" → Coffee');

    await undoCommand(db, entries[0].id);
    expect((await txnsFor("Corner Bean Cafe")).every((t) => t.categoryId === null)).toBe(true);
  });

  it("runs rules in priority order and skips disabled ones", async () => {
    await user("rules.create", { matchField: "description", matchType: "contains", pattern: "CAFE", categoryId: cat.Dining, priority: 50 });
    await user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Corner Bean Cafe", categoryId: cat.Coffee, priority: 10 });
    await runCategorization(db);
    expect((await txnsFor("Corner Bean Cafe")).every((t) => t.categoryId === cat.Coffee)).toBe(true);
  });

  it("learns from one categorization: memory fills in the rest of that merchant", async () => {
    const [first, ...rest] = await txnsFor("Quillfield Market");
    await user("transactions.setCategory", { transactionId: first.id, categoryId: cat.Groceries });
    const result = await runCategorization(db);
    expect(result.byMemory).toBe(rest.length);
    expect((await txnsFor("Quillfield Market")).every((t) => t.categoryId === cat.Groceries)).toBe(true);
    const [entry] = await db.select().from(commandLog).where(eq(commandLog.actor, "memory"));
    expect(entry.changes).toHaveLength(rest.length);
  });

  it("with mixed history, suggests instead of applying", async () => {
    const [a, b, ...rest] = await txnsFor("Quillfield Market");
    await user("transactions.setCategory", { transactionId: a.id, categoryId: cat.Groceries });
    await user("transactions.setCategory", { transactionId: b.id, categoryId: cat.Dining });
    expect((await runCategorization(db)).byMemory).toBe(0);
    const inbox = await read(db, listInbox, { limit: 500 });
    const row = inbox.find((r) => r.id === rest[0].id)!;
    expect(row.suggestedCategoryId).not.toBeNull();
    expect([cat.Groceries, cat.Dining]).toContain(row.suggestedCategoryId);
  });

  it("never touches accounts excluded from budgets", async () => {
    const [p2p] = await db.select().from(accounts).where(eq(accounts.type, "payment_app"));
    await user("accounts.update", { accountId: p2p.id, countsTowardBudgets: false });
    await user("rules.create", { matchField: "description", matchType: "starts_with", pattern: "PAYPEER", categoryId: cat.Transfers });
    await runCategorization(db);
    const p2pTxns = await db.select().from(transactions).where(eq(transactions.accountId, p2p.id));
    expect(p2pTxns.every((t) => t.categoryId === null)).toBe(true);
    const inbox = await read(db, listInbox, { limit: 500 });
    expect(inbox.some((r) => r.accountId === p2p.id)).toBe(false);
  });

  it("never overwrites a category the owner already set", async () => {
    const [one] = await txnsFor("Corner Bean Cafe");
    await user("transactions.setCategory", { transactionId: one.id, categoryId: cat.Dining });
    await user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Corner Bean Cafe", categoryId: cat.Coffee });
    await runCategorization(db);
    const [after] = await db.select().from(transactions).where(eq(transactions.id, one.id));
    expect(after.categoryId).toBe(cat.Dining);
  });

  it("is idempotent: a second run finds nothing new", async () => {
    await user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Corner Bean Cafe", categoryId: cat.Coffee });
    await runCategorization(db);
    const before = (await db.select().from(commandLog)).length;
    expect(await runCategorization(db)).toMatchObject({ byRules: 0, byMemory: 0 });
    expect(await db.select().from(commandLog)).toHaveLength(before);
  });

  it("refuses the batch operation to the owner, Tally and import", async () => {
    const [t] = await txnsFor("Corner Bean Cafe");
    for (const actor of ["user", "tally", "import"] as const) {
      await expect(
        execute(db, {
          operation: "transactions.applyCategories",
          input: { assignments: [{ transactionId: t.id, categoryId: cat.Coffee }] },
          actor,
          reason: "x",
        }),
      ).rejects.toThrow(/may not run/);
    }
  });
});

describe("backfillMerchantsIfNeeded", () => {
  it("fills missing merchants as one import command, and does nothing when there are none", async () => {
    expect(await backfillMerchantsIfNeeded(db)).toBe(0);
    expect(await db.select().from(commandLog)).toHaveLength(0);

    const some = (await db.select().from(transactions).limit(5)).map((t) => t.id);
    await db.update(transactions).set({ merchant: null }).where(inArray(transactions.id, some));
    expect(await backfillMerchantsIfNeeded(db)).toBe(5);
    const [entry] = await db.select().from(commandLog);
    expect(entry).toMatchObject({ actor: "import", operation: "transactions.backfillMerchants" });
    const filled = await db.select().from(transactions).where(inArray(transactions.id, some));
    expect(filled.every((t) => t.merchant)).toBe(true);
  });
});

describe("category tree", () => {
  it("children inherit the parent's kind and nest one level only", async () => {
    const food = (await user("categories.create", { name: "Food", kind: "expense" })) as { output: { id: string } };
    const sub = (await user("categories.create", { name: "Takeout", kind: "income", parentId: food.output.id })) as { output: { id: string; kind: string } };
    expect(sub.output.kind).toBe("expense");
    await expect(user("categories.create", { name: "Too deep", parentId: sub.output.id })).rejects.toThrow(/one level/);
  });

  it("allows the same name under different parents, not twice under one", async () => {
    const a = (await user("categories.create", { name: "Household", kind: "expense" })) as { output: { id: string } };
    const b = (await user("categories.create", { name: "Garden", kind: "expense" })) as { output: { id: string } };
    await user("categories.create", { name: "Other", parentId: a.output.id });
    await user("categories.create", { name: "Other", parentId: b.output.id });
    await expect(user("categories.create", { name: "Other", parentId: a.output.id })).rejects.toThrow(/already exists/);
  });

  it("moves a category under a parent, adopting its kind, and refuses cycles", async () => {
    const parent = (await user("categories.create", { name: "Food", kind: "expense" })) as { output: { id: string } };
    await user("categories.move", { categoryId: cat.Groceries, parentId: parent.output.id });
    const [g] = await db.select().from(categories).where(eq(categories.id, cat.Groceries));
    expect(g.parentId).toBe(parent.output.id);
    await expect(user("categories.move", { categoryId: parent.output.id, parentId: parent.output.id })).rejects.toThrow();
  });

  it("refuses to delete a category in use, and deletes an unused one", async () => {
    const [t] = await txnsFor("Corner Bean Cafe");
    await user("transactions.setCategory", { transactionId: t.id, categoryId: cat.Coffee });
    await expect(user("categories.delete", { categoryId: cat.Coffee })).rejects.toThrow(/in use: 1 transactions/);
    await user("categories.delete", { categoryId: cat.Fitness });
    expect(await db.select().from(categories).where(eq(categories.id, cat.Fitness))).toHaveLength(0);
  });

  it("rejects a rule whose amount range is backwards", async () => {
    await expect(
      user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Xx", categoryId: cat.Coffee, minAmountCents: 500, maxAmountCents: 100 }),
    ).rejects.toThrow(/above the maximum/);
  });
});
