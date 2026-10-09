import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { guessAccountType } from "@/operations/import";
import { execute, undoCommand } from "@/operations/runtime";

let db: Db;
let checkingId: string;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: checkingId }] = await db.select().from(accounts).where(eq(accounts.type, "checking"));
});

const update = (input: Record<string, unknown>) =>
  execute(db, { operation: "accounts.update", input: { accountId: checkingId, ...input }, actor: "user", reason: "test" });

async function current() {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, checkingId));
  return row;
}

describe("guessAccountType", () => {
  it.each([
    ["Everyday Checking", "checking"],
    ["Joint Checking", "checking"],
    ["Individual Checking", "checking"],
    ["Credit Union Share Checking", "checking"],
    ["High Yield Savings", "savings"],
    ["Money Market", "savings"],
    ["12-Month CD", "savings"],
    ["Rewards Visa Card", "credit"],
    ["Platinum Credit Card", "credit"],
    ["Venmo", "payment_app"],
    ["Individual Brokerage", "brokerage"],
    ["Joint WROS", "brokerage"],
    ["Self-Directed Investing", "brokerage"],
    ["Roth IRA", "retirement"],
    ["Traditional IRA", "retirement"],
    ["401(k) Plan", "retirement"],
    ["401k Savings Plan", "retirement"],
    ["Retirement Account", "retirement"],
    ["Health Savings Account HSA", "retirement"],
    ["Home Mortgage", "loan"],
    ["Auto Loan", "loan"],
    ["Mystery Account", "checking"],
  ])("%s → %s", (name, kind) => {
    expect(guessAccountType(name)).toBe(kind);
  });
});

describe("accounts.update", () => {
  it("reclassifying takes an account out of budgets by default", async () => {
    await update({ kind: "brokerage" });
    expect(await current()).toMatchObject({ type: "brokerage", countsTowardBudgets: false });
    await update({ kind: "checking" });
    expect(await current()).toMatchObject({ type: "checking", countsTowardBudgets: true });
  });

  it("an explicit flag in the same call wins over the kind's default", async () => {
    await update({ kind: "brokerage", countsTowardBudgets: true });
    expect(await current()).toMatchObject({ type: "brokerage", countsTowardBudgets: true });
  });

  it("sets and clears the display name without touching the bank's name", async () => {
    const before = await current();
    await update({ displayName: "Bills account" });
    expect(await current()).toMatchObject({ displayName: "Bills account", name: before.name });
    await update({ displayName: null });
    expect((await current()).displayName).toBeNull();
  });

  it("is undoable", async () => {
    const result = (await update({ kind: "loan", displayName: "Oops" })) as { commandId: string };
    await undoCommand(db, result.commandId);
    expect(await current()).toMatchObject({ type: "checking", displayName: null, countsTowardBudgets: true });
  });

  it("rejects an empty change and unknown kinds", async () => {
    await expect(update({})).rejects.toThrow(/Nothing to change/);
    await expect(update({ kind: "crypto" })).rejects.toThrow();
  });
});

describe("budget filtering", () => {
  it("accounts.list shows the owner's name and the budget flag, and no balances", async () => {
    await update({ displayName: "Bills account" });
    const result = await execute(db, { operation: "accounts.list", input: {}, actor: "tally", reason: "" });
    const rows = (result as { output: Record<string, unknown>[] }).output;
    const row = rows.find((r) => r.id === checkingId)!;
    expect(row).toMatchObject({ name: "Bills account", kind: "checking", countsTowardBudgets: true });
    expect(Object.keys(row)).not.toContain("balanceCents");
  });

  it("transactions.list budgetOnly leaves out excluded accounts", async () => {
    const list = async (budgetOnly: boolean) =>
      (
        (await execute(db, { operation: "transactions.list", input: { budgetOnly, limit: 500 }, actor: "user", reason: "" })) as {
          output: { accountId: string }[];
        }
      ).output;
    expect((await list(true)).some((t) => t.accountId === checkingId)).toBe(true);
    await update({ countsTowardBudgets: false });
    expect((await list(true)).some((t) => t.accountId === checkingId)).toBe(false);
    expect((await list(false)).some((t) => t.accountId === checkingId)).toBe(true);
    // Sanity: the filter removed exactly that account's rows.
    const all = await db.select().from(transactions);
    expect((await list(true)).length).toBe(Math.min(500, all.filter((t) => t.accountId !== checkingId).length));
  });
});
