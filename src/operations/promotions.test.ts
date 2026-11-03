import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, commandLog, tallyPromotions, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listPromotions } from "@/operations/promotions";
import { execute, listCommands, undoCommand } from "@/operations/runtime";

// Promoting Tally actions to auto-apply (#59), on the synthetic seed.

let db: Db;
let txnId: string;
let dining: string;
const tally = (operation: string, input: Record<string, unknown>) => execute(db, { operation, input, actor: "tally", reason: "Looks like dinner" });
const user = (operation: string, input: Record<string, unknown>) => execute(db, { operation, input, actor: "user", reason: "test" });

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: txnId }] = await db.select({ id: transactions.id }).from(transactions).limit(1);
  [{ id: dining }] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, "Dining"));
});

describe("Tally's promotions (#59)", () => {
  it("are all off by default: Tally's write is a proposal", async () => {
    expect((await listPromotions(db)).every((p) => !p.promoted)).toBe(true);
    expect(await tally("transactions.setCategory", { transactionId: txnId, categoryId: dining })).toMatchObject({ status: "proposed" });
  });

  it("let a promoted write apply at once, logged as Tally's with its reason, flagged auto-applied, and undoable", async () => {
    await user("tally.promote", { operation: "transactions.setCategory" });
    const result = await tally("transactions.setCategory", { transactionId: txnId, categoryId: dining });
    expect(result).toMatchObject({ status: "applied" });
    const [row] = await db.select().from(commandLog).where(eq(commandLog.id, (result as { commandId: string }).commandId));
    expect(row).toMatchObject({ actor: "tally", reason: "Looks like dinner", status: "applied", autoApplied: true, decidedBy: null });
    expect((await db.select().from(transactions).where(eq(transactions.id, txnId)))[0].categoryId).toBe(dining);

    await undoCommand(db, row.id, { actor: "user", reason: "test" });
    expect((await db.select().from(transactions).where(eq(transactions.id, txnId)))[0].categoryId).not.toBe(dining);
  });

  it("take effect on the next call when turned off", async () => {
    await user("tally.promote", { operation: "transactions.setCategory" });
    await user("tally.demote", { operation: "transactions.setCategory" });
    expect(await tally("transactions.setCategory", { transactionId: txnId, categoryId: dining })).toMatchObject({ status: "proposed" });
  });

  it("only exist for operations marked promotable: anything else is still a proposal", async () => {
    await expect(user("tally.promote", { operation: "rules.create" })).rejects.toThrow(/can't be promoted/);
    await expect(user("tally.promote", { operation: "nonsense.op" })).rejects.toThrow(/can't be promoted/);
    // Even with a row for it (written around the operation), a non-promotable write stays a proposal.
    await db.insert(tallyPromotions).values({ operation: "categories.create" });
    expect(await tally("categories.create", { name: "Lattes", kind: "expense" })).toMatchObject({ status: "proposed" });
  });

  it("are the owner's to set, not Tally's", async () => {
    await expect(tally("tally.promote", { operation: "transactions.setCategory" })).rejects.toThrow(/may not run/);
  });

  it("show apart in Activity: auto-applied, not approved", async () => {
    await user("tally.promote", { operation: "transactions.setTags" });
    await tally("transactions.setTags", { transactionId: txnId, tags: ["trip"] });
    const proposal = await tally("transactions.setCategory", { transactionId: txnId, categoryId: dining });
    const auto = await listCommands(db, { autoAppliedOnly: true });
    expect(auto.map((c) => c.operation)).toEqual(["transactions.setTags"]);
    expect((await listCommands(db)).find((c) => c.id === (proposal as { commandId: string }).commandId)).toMatchObject({ status: "proposed", autoApplied: false });
  });

  it("list every promotable operation with a label for Settings", async () => {
    expect((await listPromotions(db)).map((p) => p.operation).sort()).toEqual([
      "transactions.setCategories",
      "transactions.setCategory",
      "transactions.setExperienceDate",
      "transactions.setTags",
    ]);
  });
});
