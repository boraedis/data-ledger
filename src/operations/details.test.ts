import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, commandLog, tags, transactionSplits, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read, undoCommand } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { getTransaction, listInbox, listTransactions, spendingLines } from "@/operations/transactions";

// Splits, tags and experience dates (#6 phase 2) on PGlite over the
// synthetic seed. All data invented.

let db: Db;
let cat: Record<string, string>;
let grocery: typeof transactions.$inferSelect;

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  [grocery] = await db.select().from(transactions).where(eq(transactions.merchant, "Quillfield Market")).limit(1);
});

const twoParts = () => {
  const half = Math.trunc(grocery.amountCents / 2);
  return [
    { amountCents: half, categoryId: cat.Groceries },
    { amountCents: grocery.amountCents - half, categoryId: cat.Dining, note: "deli lunch" },
  ];
};

describe("transactions.split", () => {
  it("splits into parts that add up exactly, and takes it out of the inbox", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    const detail = await read(db, getTransaction, { transactionId: grocery.id });
    expect(detail).toMatchObject({ isSplit: true, categoryId: null });
    expect(detail.splits.map((s) => s.categoryId)).toEqual([cat.Groceries, cat.Dining]);
    expect(detail.splits[1].note).toBe("deli lunch");
    const inbox = await read(db, listInbox, { limit: 500 });
    expect(inbox.some((r) => r.id === grocery.id)).toBe(false);
  });

  it("refuses parts that don't add up, flip sign, or are too few", async () => {
    const parts = twoParts();
    await expect(user("transactions.split", { transactionId: grocery.id, parts: [parts[0], { ...parts[1], amountCents: parts[1].amountCents - 1 }] })).rejects.toThrow(/add up/);
    await expect(
      user("transactions.split", {
        transactionId: grocery.id,
        parts: [
          { amountCents: grocery.amountCents - 100, categoryId: cat.Groceries },
          { amountCents: 100, categoryId: cat.Dining },
        ],
      }),
    ).rejects.toThrow(/same sign/);
    await expect(user("transactions.split", { transactionId: grocery.id, parts: [parts[0]] })).rejects.toThrow();
  });

  it("re-splitting replaces the parts; choosing one category removes the split", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    const third = Math.trunc(grocery.amountCents / 3);
    await user("transactions.split", {
      transactionId: grocery.id,
      parts: [
        { amountCents: third, categoryId: cat.Groceries },
        { amountCents: third, categoryId: cat.Dining },
        { amountCents: grocery.amountCents - 2 * third, categoryId: cat.Coffee },
      ],
    });
    expect(await db.select().from(transactionSplits)).toHaveLength(3);
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Groceries });
    expect(await db.select().from(transactionSplits)).toHaveLength(0);
    expect(await read(db, getTransaction, { transactionId: grocery.id })).toMatchObject({ isSplit: false, categoryId: cat.Groceries });
  });

  it("undo restores the previous category and removes the parts", async () => {
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Groceries });
    const { commandId } = await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    await undoCommand(db, commandId);
    expect(await db.select().from(transactionSplits)).toHaveLength(0);
    expect(await read(db, getTransaction, { transactionId: grocery.id })).toMatchObject({ isSplit: false, categoryId: cat.Groceries });
  });

  it("the pipeline never touches a split transaction", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    await user("rules.create", { matchField: "merchant", matchType: "equals", pattern: "Quillfield Market", categoryId: cat.Coffee });
    await runCategorization(db);
    expect(await read(db, getTransaction, { transactionId: grocery.id })).toMatchObject({ isSplit: true, categoryId: null });
  });

  it("a category used by a split part can't be deleted", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    await expect(user("categories.delete", { categoryId: cat.Dining })).rejects.toThrow(/1 split parts/);
  });
});

describe("spending lines", () => {
  it("expands splits, dates by experience date, and leaves out uncategorized", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    await user("transactions.setExperienceDate", { transactionId: grocery.id, experiencedOn: "2026-12-24" });
    const lines = await read(db, spendingLines, { from: "2026-12-01", to: "2026-12-31" });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.transactionId === grocery.id && l.date === "2026-12-24")).toBe(true);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(grocery.amountCents);
    expect(new Set(lines.map((l) => l.categoryId))).toEqual(new Set([cat.Groceries, cat.Dining]));
    // Nothing else is categorized yet, so nothing else appears anywhere.
    expect(await read(db, spendingLines, {})).toHaveLength(2);
  });

  it("clearing the experience date returns it to the posted date", async () => {
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Groceries });
    await user("transactions.setExperienceDate", { transactionId: grocery.id, experiencedOn: "2026-12-24" });
    await user("transactions.setExperienceDate", { transactionId: grocery.id, experiencedOn: null });
    const [line] = await read(db, spendingLines, {});
    expect(line.date).toBe(grocery.postedOn);
  });
});

describe("tags", () => {
  it("creates tags by name, ignoring case, and sets the full list", async () => {
    await user("transactions.setTags", { transactionId: grocery.id, tags: ["Vacation-2026", "gift", "vacation-2026"] });
    expect((await db.select().from(tags)).map((t) => t.name).sort()).toEqual(["Vacation-2026", "gift"]);
    await user("transactions.setTags", { transactionId: grocery.id, tags: ["VACATION-2026"] });
    const detail = await read(db, getTransaction, { transactionId: grocery.id });
    expect(detail.tags.map((t) => t.name)).toEqual(["Vacation-2026"]);
    expect(await db.select().from(tags)).toHaveLength(2); // removing from a transaction keeps the tag
  });

  it("renames, refuses a clash, and deletes with undo restoring every link", async () => {
    const [other] = await db.select().from(transactions).where(eq(transactions.merchant, "Corner Bean Cafe")).limit(1);
    await user("transactions.setTags", { transactionId: grocery.id, tags: ["trip"] });
    await user("transactions.setTags", { transactionId: other.id, tags: ["trip", "work"] });
    const byName = Object.fromEntries((await read(db, listTags, {})).map((t) => [t.name, t]));
    expect(byName.trip.transactions).toBe(2);
    await expect(user("tags.rename", { tagId: byName.trip.id, name: "WORK" })).rejects.toThrow(/already exists/);

    const { commandId } = await user("tags.delete", { tagId: byName.trip.id });
    expect(await db.select().from(transactionTags)).toHaveLength(1);
    await undoCommand(db, commandId);
    expect(await db.select().from(transactionTags)).toHaveLength(3);
  });
});

describe("transactions.list filters", () => {
  it("finds a transaction by a category used only in its split", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    const rows = await read(db, listTransactions, { categoryId: cat.Dining, limit: 500 });
    expect(rows.map((r) => r.id)).toEqual([grocery.id]);
    expect(rows[0].isSplit).toBe(true);
  });

  it("filters by tag and returns tags on each row", async () => {
    await user("transactions.setTags", { transactionId: grocery.id, tags: ["gift"] });
    const [{ id: tagId }] = await db.select().from(tags);
    const rows = await read(db, listTransactions, { tagId, limit: 500 });
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual(["gift"]);
  });

  it("searches merchant and description, treating % and _ literally", async () => {
    const hits = await read(db, listTransactions, { search: "corner bean", limit: 500 });
    expect(hits.length).toBeGreaterThan(20);
    expect(hits.every((r) => r.merchant === "Corner Bean Cafe")).toBe(true);
    expect(await read(db, listTransactions, { search: "%", limit: 500 })).toHaveLength(0);
    expect(await read(db, listTransactions, { search: "_", limit: 500 })).toHaveLength(0);
  });

  it("pages with offset", async () => {
    const first = await read(db, listTransactions, { limit: 10 });
    const second = await read(db, listTransactions, { limit: 10, offset: 10 });
    expect(second).toHaveLength(10);
    expect(first.some((r) => second.some((s) => s.id === r.id))).toBe(false);
  });
});

describe("activity", () => {
  it("logs each edit with a readable operation", async () => {
    await user("transactions.split", { transactionId: grocery.id, parts: twoParts() });
    await user("transactions.setTags", { transactionId: grocery.id, tags: ["gift"] });
    await user("transactions.setExperienceDate", { transactionId: grocery.id, experiencedOn: "2026-12-24" });
    const ops = (await db.select().from(commandLog)).map((e) => e.operation).sort();
    expect(ops).toEqual(["transactions.setExperienceDate", "transactions.setTags", "transactions.split"]);
  });
});
