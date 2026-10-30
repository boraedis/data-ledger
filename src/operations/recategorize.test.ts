import { eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, commandLog, transactionSplits, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { moveToCategoryPreview } from "@/operations/recategorize";
import { execute, read, undoCommand } from "@/operations/runtime";

// Moving many transactions to one category (#116), on the synthetic seed:
// CORNER BEAN CAFE purchases filed as Coffee move to a made-up "Cafes".

let db: Db;
let cat: Record<string, string>;
let cafes: string;
let coffee: (typeof transactions.$inferSelect)[];

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  // Only the café is Coffee, so the category ends up unused once it moves.
  await db.update(transactions).set({ categoryId: null }).where(eq(transactions.categoryId, cat.Coffee));
  await db.update(transactions).set({ categoryId: cat.Coffee }).where(like(transactions.description, "CORNER BEAN%"));
  coffee = await db.select().from(transactions).where(like(transactions.description, "CORNER BEAN%"));
  expect(coffee.length).toBeGreaterThan(3);
  cafes = ((await user("categories.create", { name: "Cafes", kind: "expense" })).output as { id: string }).id;
});

describe("transactions.moveToCategoryPreview", () => {
  it("lists everything matching a filter with old and new category, and writes nothing", async () => {
    const preview = await read(db, moveToCategoryPreview, { categoryId: cafes, filter: { categoryId: cat.Coffee } });
    expect(preview.changes.map((c) => c.transactionId).sort()).toEqual(coffee.map((t) => t.id).sort());
    expect(preview.changes[0]).toMatchObject({ fromCategoryName: "Coffee", toCategoryName: "Cafes", skipReason: null });
    expect(preview).toMatchObject({ alreadyThere: 0, pairedTransfers: 0, truncated: false });
    expect((await row(coffee[0].id)).categoryId).toBe(cat.Coffee);
  });

  it("marks a split to be left out unless ticked, and counts what's already there", async () => {
    const [split, there] = coffee;
    await user("transactions.split", {
      transactionId: split.id,
      parts: [
        { amountCents: split.amountCents + 100, categoryId: cat.Coffee },
        { amountCents: -100, categoryId: cat.Dining },
      ],
    });
    await user("transactions.setCategory", { transactionId: there.id, categoryId: cafes });
    const preview = await read(db, moveToCategoryPreview, { categoryId: cafes, transactionIds: coffee.map((t) => t.id) });
    expect(preview.changes.find((c) => c.transactionId === split.id)).toMatchObject({ fromCategoryName: "Split", skipReason: "split across categories" });
    expect(preview.changes.some((c) => c.transactionId === there.id)).toBe(false);
    expect(preview.alreadyThere).toBe(1);
  });
});

describe("transactions.moveToCategory", () => {
  it("moves the ticked rows as one owner command, reports a category left unused, and undo restores them", async () => {
    const ids = coffee.map((t) => t.id);
    const result = await user("transactions.moveToCategory", { categoryId: cafes, transactionIds: ids });
    expect(result.output).toEqual({ moved: coffee.length, unusedCategoryIds: [cat.Coffee] });
    for (const id of ids) expect((await row(id)).categoryId).toBe(cafes);
    const [logged] = await db.select().from(commandLog).where(eq(commandLog.operation, "transactions.moveToCategory"));
    expect(logged).toMatchObject({ actor: "user", status: "applied" });

    await undoCommand(db, result.commandId);
    for (const id of ids) expect((await row(id)).categoryId).toBe(cat.Coffee);
  });

  it("replaces a split only when it's ticked, and only the owner can run it", async () => {
    const [split, other] = coffee;
    await user("transactions.split", {
      transactionId: split.id,
      parts: [
        { amountCents: split.amountCents + 100, categoryId: cat.Coffee },
        { amountCents: -100, categoryId: cat.Dining },
      ],
    });
    // Not ticked: untouched, and Coffee is still used by its part.
    const first = await user("transactions.moveToCategory", { categoryId: cafes, transactionIds: coffee.filter((t) => t.id !== split.id).map((t) => t.id) });
    expect(first.output).toMatchObject({ unusedCategoryIds: [] });
    expect(await row(split.id)).toMatchObject({ isSplit: true, categoryId: null });

    // Ticked: the split goes, and so does Coffee's last use.
    const second = await user("transactions.moveToCategory", { categoryId: cafes, transactionIds: [split.id] });
    // Its parts' categories count as sources too (Dining was used only by the part here).
    expect(second.output).toEqual({ moved: 1, unusedCategoryIds: expect.arrayContaining([cat.Coffee, cat.Dining]) });
    expect(await row(split.id)).toMatchObject({ isSplit: false, categoryId: cafes });
    expect(await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, split.id))).toEqual([]);

    await expect(
      execute(db, { operation: "transactions.moveToCategory", input: { categoryId: cat.Dining, transactionIds: [other.id] }, actor: "tally", reason: "test" }),
    ).rejects.toThrow(/may not run/);
  });
});
