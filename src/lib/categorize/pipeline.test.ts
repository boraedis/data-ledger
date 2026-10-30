import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillMerchantsIfNeeded, runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listRecurring } from "@/operations/recurring";
import { listInbox } from "@/operations/transactions";
import { execute, read, undoCommand } from "@/operations/runtime";

// The pipeline end to end on PGlite over the synthetic seed: rules, then
// merchant memory's suggestions, then the inbox. Only rules categorize on
// their own (#86). All data invented.

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
    expect(result.byRules).toBe(0);
    expect(result.remaining).toBeGreaterThan(200);
    // The only writes are the transfer matcher pairing the seed's moves
    // between its own accounts, one command per kind; nothing was categorized.
    expect((await db.select().from(commandLog)).map((c) => [c.actor, c.reason])).toEqual([
      ["matcher", "Matched 6 transfers between cash and investment accounts"],
      ["matcher", "Matched 6 transfers paying a card or loan"],
      ["matcher", "Matched 12 transfers between cash accounts"],
    ]);
  });

  it("pairs a card payment with its credit on the card, so it's never spending, income or a subscription", async () => {
    await runCategorization(db);
    const payments = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT"));
    expect(payments.length).toBeGreaterThan(0);
    for (const p of payments) {
      expect(p.transferPairId).not.toBeNull();
      const [credit] = await db.select().from(transactions).where(eq(transactions.id, p.transferPairId!));
      expect(credit).toMatchObject({ description: "PAYMENT THANK YOU", amountCents: -p.amountCents });
    }
    const inbox = await read(db, listInbox, { limit: 500 });
    expect(inbox.some((r) => payments.some((p) => p.id === r.id) || r.description === "PAYMENT THANK YOU")).toBe(false);
    const recurring = await read(db, listRecurring, { on: "2026-06-30" });
    expect(recurring.some((r) => /Card Co Payment/.test(r.merchant))).toBe(false);
  });

  it("also pairs a card payment already filed under a transfer category, but not one filed as spending", async () => {
    const [payment] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(1);
    const [other] = (await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT"))).slice(1);
    await user("transactions.setCategory", { transactionId: payment.id, categoryId: cat.Transfers });
    await user("transactions.setCategory", { transactionId: other.id, categoryId: cat.Dining });
    await runCategorization(db);
    expect((await db.select().from(transactions).where(eq(transactions.id, payment.id)))[0].transferPairId).not.toBeNull();
    expect((await db.select().from(transactions).where(eq(transactions.id, other.id)))[0].transferPairId).toBeNull();
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

  it("learns from one categorization, as a suggestion: the rest of that merchant waits, pre-selected (#86)", async () => {
    const [first, ...rest] = await txnsFor("Quillfield Market");
    await user("transactions.setCategory", { transactionId: first.id, categoryId: cat.Groceries });
    const result = await runCategorization(db);
    expect(result.byRules).toBe(0);
    expect((await txnsFor("Quillfield Market")).filter((t) => t.categoryId !== null)).toHaveLength(1);
    expect(await db.select().from(commandLog).where(eq(commandLog.actor, "memory"))).toEqual([]);
    const inbox = await read(db, listInbox, { limit: 500 });
    const row = inbox.find((r) => r.id === rest[0].id)!;
    expect(row).toMatchObject({ suggestedCategoryId: cat.Groceries, suggestionSource: "memory", suggestionAgrees: true });
  });

  it("with mixed history, suggests the most common, marked as varying", async () => {
    const [a, b, ...rest] = await txnsFor("Quillfield Market");
    await user("transactions.setCategory", { transactionId: a.id, categoryId: cat.Groceries });
    await user("transactions.setCategory", { transactionId: b.id, categoryId: cat.Dining });
    await runCategorization(db);
    const inbox = await read(db, listInbox, { limit: 500 });
    const row = inbox.find((r) => r.id === rest[0].id)!;
    expect(row.suggestionAgrees).toBe(false);
    expect([cat.Groceries, cat.Dining]).toContain(row.suggestedCategoryId);
  });

  it("confirms a set of suggestions as the owner, in one undoable command", async () => {
    const [first, ...rest] = await txnsFor("Quillfield Market");
    await user("transactions.setCategory", { transactionId: first.id, categoryId: cat.Groceries });
    // One of them the owner has filed differently meanwhile: left alone.
    await user("transactions.setCategory", { transactionId: rest[0].id, categoryId: cat.Dining });
    const result = await user("transactions.setCategories", { assignments: rest.map((t) => ({ transactionId: t.id, categoryId: cat.Groceries })) });
    expect((result as { output: { applied: number } }).output.applied).toBe(rest.length - 1);
    const [entry] = await db.select().from(commandLog).where(eq(commandLog.operation, "transactions.setCategories"));
    expect(entry.actor).toBe("user");
    expect((await txnsFor("Quillfield Market")).filter((t) => t.categoryId === cat.Groceries)).toHaveLength(rest.length);

    await undoCommand(db, entry.id);
    const after = await txnsFor("Quillfield Market");
    expect(after.filter((t) => t.categoryId === cat.Groceries).map((t) => t.id)).toEqual([first.id]);
    expect(after.find((t) => t.id === rest[0].id)!.categoryId).toBe(cat.Dining);
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
    expect(await runCategorization(db)).toMatchObject({ byRules: 0 });
    expect(await db.select().from(commandLog)).toHaveLength(before);
  });

  it("refuses the batch operation to all but rules: not the owner, Tally, import, memory or the model (#86)", async () => {
    const [t] = await txnsFor("Corner Bean Cafe");
    for (const actor of ["user", "tally", "import", "memory", "model"] as const) {
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
