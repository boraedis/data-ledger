import { eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read, undoCommand } from "@/operations/runtime";
import { reapplyPreview } from "@/operations/rules";

// Re-applying a rule to transactions that already have a category (#100),
// on the synthetic seed: QUILLFIELD MARKET purchases are filed by a rule
// that pointed at the wrong category, then the rule is fixed.

let db: Db;
let cat: Record<string, string>;
let ruleId: string;
let quillfield: (typeof transactions.$inferSelect)[];

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const categoryOf = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0].categoryId;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  await db.update(transactions).set({ categoryId: null }).where(like(transactions.description, "QUILLFIELD%"));
  // A rule filing them under Dining, run as the nightly pipeline would.
  ruleId = ((await user("rules.create", { matchField: "description", matchType: "contains", pattern: "QUILLFIELD", categoryId: cat.Dining })).output as { id: string }).id;
  await runCategorization(db);
  quillfield = await db.select().from(transactions).where(like(transactions.description, "QUILLFIELD%"));
  expect(quillfield.length).toBeGreaterThan(3);
  expect(quillfield.every((t) => t.categoryId === cat.Dining)).toBe(true);
  // Fixed: they're groceries. Saving the rule doesn't touch what it filed.
  await user("rules.update", { ruleId, categoryId: cat.Groceries });
});

describe("rules.reapplyPreview", () => {
  it("lists every categorized transaction the rule would change, old and new, and changes nothing", async () => {
    const preview = await read(db, reapplyPreview, { ruleId });
    expect(preview.map((c) => c.transactionId).sort()).toEqual(quillfield.map((t) => t.id).sort());
    expect(preview[0]).toMatchObject({ ruleId, fromCategoryName: "Dining", toCategoryName: "Groceries", setBy: `rule:${ruleId}`, skipReason: null });
    expect(await categoryOf(quillfield[0].id)).toBe(cat.Dining);
  });

  it("marks the owner's own choices, rows with no record, and transfers to be left out unless ticked", async () => {
    const [mine, unknown, transfer] = quillfield;
    await user("transactions.setCategory", { transactionId: mine.id, categoryId: cat.Coffee });
    // Set outside the log, as data from before it would be.
    await db.update(transactions).set({ categoryId: cat.Coffee }).where(eq(transactions.id, unknown.id));
    await user("transactions.setCategory", { transactionId: transfer.id, categoryId: cat.Transfers });

    const reason = new Map((await read(db, reapplyPreview, { ruleId })).map((c) => [c.transactionId, c.skipReason]));
    expect(reason.get(mine.id)).toBe("set by you");
    expect(reason.get(unknown.id)).toBe("no record of who set it");
    expect(reason.get(transfer.id)).toBe("filed as a transfer");
    expect(reason.get(quillfield[3].id)).toBeNull();
  });

  it("keeps rule priority: a higher rule that also matches still wins", async () => {
    await user("rules.create", { matchField: "description", matchType: "contains", pattern: "QUILLFIELD MARKET", categoryId: cat.Dining, priority: 0 });
    await user("rules.update", { ruleId, priority: 10 });
    expect(await read(db, reapplyPreview, { ruleId })).toEqual([]);
  });
});

describe("rules.reapply", () => {
  it("applies the ticked rows as one command by the owner, and undo restores them all", async () => {
    const [mine, ...rest] = quillfield;
    await user("transactions.setCategory", { transactionId: mine.id, categoryId: cat.Coffee });
    const ticked = (await read(db, reapplyPreview, { ruleId })).filter((c) => c.skipReason === null).map((c) => c.transactionId);
    expect(ticked.sort()).toEqual(rest.map((t) => t.id).sort());

    const result = await user("rules.reapply", { ruleId, transactionIds: ticked });
    expect(result.output).toEqual({ applied: rest.length });
    for (const t of rest) expect(await categoryOf(t.id)).toBe(cat.Groceries);
    expect(await categoryOf(mine.id)).toBe(cat.Coffee);
    const [logged] = await db.select().from(commandLog).where(eq(commandLog.operation, "rules.reapply"));
    expect(logged).toMatchObject({ actor: "user", status: "applied" });
    expect(logged.changes).toHaveLength(rest.length);

    await undoCommand(db, result.commandId);
    for (const t of rest) expect(await categoryOf(t.id)).toBe(cat.Dining);
  });

  it("skips what changed since the preview, and only the owner can run it", async () => {
    const [moved, other] = quillfield;
    await user("transactions.setCategory", { transactionId: moved.id, categoryId: cat.Groceries });
    const result = await user("rules.reapply", { ruleId, transactionIds: [moved.id, other.id] });
    expect(result.output).toEqual({ applied: 1 });
    await expect(execute(db, { operation: "rules.reapply", input: { ruleId, transactionIds: [other.id] }, actor: "tally", reason: "test" })).rejects.toThrow(/may not run/);
  });
});
