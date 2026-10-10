import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, transactions } from "@/db/schema";
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

describe("manual accounts", () => {
  const run = (operation: string, input: Record<string, unknown>) =>
    execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: Record<string, unknown> }>;
  const history = (accountId: string) =>
    db
      .select({ on: balanceSnapshots.on, cents: balanceSnapshots.balanceCents })
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, accountId))
      .orderBy(balanceSnapshots.on);
  const account = async (id: string) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0];

  it("creates an account outside budgets, with its first dated value", async () => {
    const { output } = await run("accounts.createManual", { name: "Hatchback", kind: "other_asset", valueCents: 1_200_000, on: "2026-06-01" });
    const id = output.id as string;
    expect(await account(id)).toMatchObject({ source: "manual", institution: "Manual", countsTowardBudgets: false, balanceCents: 1_200_000, connectionId: null });
    expect(await history(id)).toEqual([{ on: "2026-06-01", cents: 1_200_000 }]);
  });

  it("each update is a dated value; back-filling doesn't replace the current one; same day corrects", async () => {
    const { output } = await run("accounts.createManual", { name: "Loan from a friend", kind: "loan", valueCents: 500_000, on: "2026-05-01" });
    const id = output.id as string;
    await run("accounts.setManualValue", { accountId: id, valueCents: 400_000, on: "2026-06-01" });
    await run("accounts.setManualValue", { accountId: id, valueCents: 450_000, on: "2026-05-15" });
    expect((await account(id)).balanceCents).toBe(400_000);
    await run("accounts.setManualValue", { accountId: id, valueCents: 390_000, on: "2026-06-01" });
    expect(await history(id)).toEqual([
      { on: "2026-05-01", cents: 500_000 },
      { on: "2026-05-15", cents: 450_000 },
      { on: "2026-06-01", cents: 390_000 },
    ]);
    expect((await account(id)).balanceCents).toBe(390_000);
  });

  it("updates are undoable, and removal takes history with it, undoably", async () => {
    const { output } = await run("accounts.createManual", { name: "House", kind: "other_asset", valueCents: 30_000_000, on: "2026-01-01" });
    const id = output.id as string;
    const { commandId } = await run("accounts.setManualValue", { accountId: id, valueCents: 31_000_000, on: "2026-06-01" });
    await undoCommand(db, commandId);
    expect((await account(id)).balanceCents).toBe(30_000_000);
    expect(await history(id)).toHaveLength(1);

    const removed = await run("accounts.deleteManual", { accountId: id });
    expect(await account(id)).toBeUndefined();
    expect(await history(id)).toHaveLength(0);
    await undoCommand(db, removed.commandId);
    expect(await history(id)).toHaveLength(1);
  });

  it("refuses synced accounts, future dates, negative values, and anyone but the owner", async () => {
    await expect(run("accounts.setManualValue", { accountId: checkingId, valueCents: 1, on: "2026-06-01" })).rejects.toThrow(/bank sync/);
    await expect(run("accounts.deleteManual", { accountId: checkingId })).rejects.toThrow(/bank sync/);
    await expect(run("accounts.createManual", { name: "X", kind: "other_asset", valueCents: 1, on: "2999-01-01" })).rejects.toThrow();
    await expect(run("accounts.createManual", { name: "X", kind: "other_asset", valueCents: -1, on: "2026-01-01" })).rejects.toThrow();
    await expect(
      execute(db, { operation: "accounts.createManual", input: { name: "X", kind: "other_asset", valueCents: 1, on: "2026-01-01" }, actor: "tally", reason: "x" }),
    ).rejects.toThrow(/may not run/);
  });

  it("stays out of budgets whatever kind it's changed to", async () => {
    const { output } = await run("accounts.createManual", { name: "Old Bank", kind: "other_asset", valueCents: 1, on: "2026-06-01" });
    await run("accounts.update", { accountId: output.id, kind: "checking" });
    expect(await account(output.id as string)).toMatchObject({ type: "checking", countsTowardBudgets: false });
  });

  it("shows as manual in the account list", async () => {
    await run("accounts.createManual", { name: "Hatchback", kind: "other_asset", valueCents: 1, on: "2026-06-01" });
    const list = (await execute(db, { operation: "accounts.list", input: {}, actor: "user", reason: "" })) as { output: { name: string; manual: boolean }[] };
    expect(list.output.find((a) => a.name === "Hatchback")?.manual).toBe(true);
    expect(list.output.filter((a) => a.manual)).toHaveLength(1);
  });
});
