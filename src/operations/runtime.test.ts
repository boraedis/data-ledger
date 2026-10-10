import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { describeOperations, operations } from "@/operations/registry";
import {
  OperationError,
  UndoConflictError,
  approveProposal,
  execute,
  rejectProposal,
  undoCommand,
} from "@/operations/runtime";

// Two operations that exist only here: one that fails after a tracked write
// (to prove the transaction rolls back), and one that deletes (no real
// operation does yet, but undo must restore deleted rows).
vi.mock("@/operations/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/operations/registry")>();
  const { defineWrite } = await import("@/operations/define");
  const schema = await import("@/db/schema");
  const testOps = [
    defineWrite({
      name: "test.failAfterWrite",
      description: "Test only: writes, then throws.",
      input: z.object({ transactionId: z.uuid(), categoryId: z.uuid() }),
      apply: async (ctx, input) => {
        await ctx.update(schema.transactions, input.transactionId, { categoryId: input.categoryId });
        throw new Error("boom");
      },
    }),
    defineWrite({
      name: "test.insertThenUpdate",
      description: "Test only: inserts a category, then changes it in the same command.",
      input: z.object({}),
      apply: async (ctx) => {
        const row = await ctx.insert(schema.categories, { name: "Draft", kind: "expense" });
        return ctx.update(schema.categories, row.id, { name: "Final" });
      },
    }),
    defineWrite({
      name: "test.deleteCategory",
      description: "Test only: deletes a category.",
      input: z.object({ categoryId: z.uuid() }),
      apply: (ctx, input) => ctx.remove(schema.categories, input.categoryId),
    }),
  ];
  return {
    ...actual,
    getOperation: (name: string) => testOps.find((op) => op.name === name) ?? actual.getOperation(name),
  };
});

let db: Db;
let txnId: string;
let groceriesId: string;
let diningId: string;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  const [txn] = await db.select().from(transactions).limit(1);
  txnId = txn.id;
  const cats = await db.select().from(categories);
  groceriesId = cats.find((c) => c.name === "Groceries")!.id;
  diningId = cats.find((c) => c.name === "Dining")!.id;
});

const setCategory = (categoryId: string | null, actor: "user" | "tally" = "user") =>
  execute(db, {
    operation: "transactions.setCategory",
    input: { transactionId: txnId, categoryId },
    actor,
    reason: "test",
  });

async function categoryOf(id = txnId) {
  const [row] = await db.select({ categoryId: transactions.categoryId }).from(transactions).where(eq(transactions.id, id));
  return row.categoryId;
}

describe("registry", () => {
  it("has unique names and a JSON Schema for every operation", () => {
    const names = operations.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
    for (const described of describeOperations()) {
      expect(described.inputSchema).toMatchObject({ type: "object" });
      expect(described.description.length).toBeGreaterThan(10);
    }
  });
});

describe("execute", () => {
  it("runs reads without logging them", async () => {
    const result = await execute(db, { operation: "transactions.list", input: { limit: 5 }, actor: "tally", reason: "" });
    expect(result.status).toBe("read");
    expect((result as { output: unknown[] }).output).toHaveLength(5);
    expect(await db.select().from(commandLog)).toHaveLength(0);
  });

  it("applies a write and logs actor, input, reason and before/after", async () => {
    const result = await setCategory(groceriesId);
    expect(result.status).toBe("applied");
    expect(await categoryOf()).toBe(groceriesId);

    const [entry] = await db.select().from(commandLog);
    expect(entry).toMatchObject({ actor: "user", operation: "transactions.setCategory", reason: "test", status: "applied" });
    expect(entry.changes).toHaveLength(1);
    expect(entry.changes[0]).toMatchObject({ table: "transactions", id: txnId });
    expect(entry.changes[0].before).toMatchObject({ category_id: null });
    expect(entry.changes[0].after).toMatchObject({ category_id: groceriesId });
  });

  it("rejects invalid input and logs nothing", async () => {
    await expect(
      execute(db, { operation: "transactions.setCategory", input: { transactionId: "nope" }, actor: "user", reason: "x" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await db.select().from(commandLog)).toHaveLength(0);
  });

  it("rejects unknown operations, bad actors and missing reasons", async () => {
    await expect(execute(db, { operation: "nope", input: {}, actor: "user", reason: "x" })).rejects.toThrow(OperationError);
    await expect(
      execute(db, { operation: "accounts.list", input: {}, actor: "someone" as "user", reason: "x" }),
    ).rejects.toThrow(/actor/);
    await expect(
      execute(db, { operation: "transactions.setCategory", input: { transactionId: txnId, categoryId: null }, actor: "user", reason: " " }),
    ).rejects.toThrow(/reason/);
  });

  it("rolls back the write and logs nothing when an operation fails partway", async () => {
    await expect(
      execute(db, { operation: "test.failAfterWrite", input: { transactionId: txnId, categoryId: groceriesId }, actor: "user", reason: "x" }),
    ).rejects.toThrow("boom");
    expect(await categoryOf()).toBeNull();
    expect(await db.select().from(commandLog)).toHaveLength(0);
  });
});

describe("proposals", () => {
  it("stages Tally's writes instead of applying them", async () => {
    const result = await setCategory(groceriesId, "tally");
    expect(result.status).toBe("proposed");
    expect(await categoryOf()).toBeNull();
  });

  it("applies on approval, recording who decided", async () => {
    const { commandId } = (await setCategory(groceriesId, "tally")) as { commandId: string };
    await approveProposal(db, commandId);
    expect(await categoryOf()).toBe(groceriesId);
    const [entry] = await db.select().from(commandLog).where(eq(commandLog.id, commandId));
    expect(entry).toMatchObject({ status: "applied", actor: "tally", decidedBy: "user" });
    expect(entry.changes).toHaveLength(1);
  });

  it("can be rejected, and then can't be approved", async () => {
    const { commandId } = (await setCategory(groceriesId, "tally")) as { commandId: string };
    await rejectProposal(db, commandId);
    await expect(approveProposal(db, commandId)).rejects.toThrow(/rejected/);
    expect(await categoryOf()).toBeNull();
  });

  it("lets any actor opt into proposing", async () => {
    const result = await execute(db, {
      operation: "categories.create",
      input: { name: "Pets", kind: "expense" },
      actor: "user",
      reason: "test",
      propose: true,
    });
    expect(result.status).toBe("proposed");
  });
});

describe("undo", () => {
  it("restores an update", async () => {
    const { commandId } = (await setCategory(groceriesId)) as { commandId: string };
    await undoCommand(db, commandId);
    expect(await categoryOf()).toBeNull();
    const log = await db.select().from(commandLog);
    expect(log.find((e) => e.id === commandId)?.status).toBe("undone");
    expect(log.find((e) => e.undoOf === commandId)).toMatchObject({ status: "applied", actor: "user" });
  });

  it("removes an insert", async () => {
    const result = await execute(db, {
      operation: "categories.create",
      input: { name: "Pets", kind: "expense" },
      actor: "user",
      reason: "test",
    });
    await undoCommand(db, (result as { commandId: string }).commandId);
    expect(await db.select().from(categories).where(eq(categories.name, "Pets"))).toHaveLength(0);
  });

  it("refuses when the row changed since, and leaves it alone", async () => {
    const first = (await setCategory(groceriesId)) as { commandId: string };
    await setCategory(diningId);
    await expect(undoCommand(db, first.commandId)).rejects.toBeInstanceOf(UndoConflictError);
    expect(await categoryOf()).toBe(diningId);
  });

  it("works newest-first through a chain of edits", async () => {
    const first = (await setCategory(groceriesId)) as { commandId: string };
    const second = (await setCategory(diningId)) as { commandId: string };
    await undoCommand(db, second.commandId);
    expect(await categoryOf()).toBe(groceriesId);
    await undoCommand(db, first.commandId);
    expect(await categoryOf()).toBeNull();
  });

  it("re-inserts a deleted row exactly as it was", async () => {
    const [before] = await db.select().from(categories).where(eq(categories.id, diningId));
    const result = await execute(db, { operation: "test.deleteCategory", input: { categoryId: diningId }, actor: "user", reason: "x" });
    expect(await db.select().from(categories).where(eq(categories.id, diningId))).toHaveLength(0);
    await undoCommand(db, (result as { commandId: string }).commandId);
    const [after] = await db.select().from(categories).where(eq(categories.id, diningId));
    expect(after).toEqual(before);
  });

  it("undoes a command that changed the same row more than once", async () => {
    const result = await execute(db, { operation: "test.insertThenUpdate", input: {}, actor: "user", reason: "x" });
    expect(await db.select().from(categories).where(eq(categories.name, "Final"))).toHaveLength(1);
    await undoCommand(db, (result as { commandId: string }).commandId);
    expect(await db.select().from(categories).where(eq(categories.name, "Final"))).toHaveLength(0);
    expect(await db.select().from(categories).where(eq(categories.name, "Draft"))).toHaveLength(0);
  });

  it("can't undo twice, undo an undo, or undo a proposal", async () => {
    const { commandId } = (await setCategory(groceriesId)) as { commandId: string };
    const { commandId: undoId } = await undoCommand(db, commandId);
    await expect(undoCommand(db, commandId)).rejects.toThrow(/undone/);
    await expect(undoCommand(db, undoId)).rejects.toThrow(/can't itself be undone/);
    const proposal = (await setCategory(diningId, "tally")) as { commandId: string };
    await expect(undoCommand(db, proposal.commandId)).rejects.toThrow(/proposed/);
  });
});
