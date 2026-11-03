import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, manualPositions } from "@/db/schema";
import type { Db } from "@/db/types";
import { netWorthSummary } from "@/lib/net-worth";
import { testDb } from "@/lib/test-utils/db";
import { listManualPositions } from "@/operations/holdings";
import { describeOperations } from "@/operations/registry";
import { execute, undoCommand } from "@/operations/runtime";

// Positions kept by hand (#231), in an empty ledger so net worth is only
// what each test adds. Symbols, quantities and prices are invented.

let db: Db;
let wallet: string;
type Out = { status: string; commandId: string; output: { id: string } };
const run = (operation: string, input: Record<string, unknown>, actor = "user") =>
  execute(db, { operation, input, actor: actor as "user", reason: "test" }) as Promise<Out>;
const day = new Date().toISOString().slice(0, 10);
const net = async () => (await netWorthSummary(db)).netCents;
const value = async () => (await db.select().from(accounts).where(eq(accounts.id, wallet)))[0].balanceCents;

beforeEach(async () => {
  db = await testDb();
  wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
});

const add = (symbol: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) =>
  run("holdings.addManual", { accountId: wallet, symbol, quantity, unitPrice, ...extra });

describe("hand-entered positions (#231)", () => {
  it("values the account as quantity × price, and net worth follows with no sync", async () => {
    await add("zqc", "0.5", "40000");
    await add("BLX", "1,250", "0.08", { costBasisCents: 9_000 });
    expect(await value()).toBe(2_000_000 + 10_000);
    expect(await net()).toBe(2_010_000);

    const [zqc] = (await listManualPositions(db)).filter((p) => p.symbol === "ZQC");
    await run("holdings.setQuantity", { positionId: zqc.id, quantity: "0.75" });
    expect(await net()).toBe(3_000_000 + 10_000);
    await run("holdings.setPrice", { positionId: zqc.id, unitPrice: "42000", priceOn: day });
    expect(await net()).toBe(3_150_000 + 10_000);
  });

  it("makes each add, change and remove one undoable command", async () => {
    const added = await add("ZQC", "0.5", "40000");
    const positionId = added.output.id;
    const changed = await run("holdings.setQuantity", { positionId, quantity: "2" });
    const removed = await run("holdings.remove", { positionId });
    expect(await value()).toBe(0);

    await undoCommand(db, removed.commandId, { actor: "user", reason: "test" });
    expect(await value()).toBe(8_000_000);
    await undoCommand(db, changed.commandId, { actor: "user", reason: "test" });
    expect(await value()).toBe(2_000_000);
    await undoCommand(db, added.commandId, { actor: "user", reason: "test" });
    expect(await db.select().from(manualPositions)).toEqual([]);
    expect(await value()).toBe(0);
  });

  it("shows the owner's price with its date, and records the day's value in the account's history", async () => {
    await add("ZQC", "0.5", "40000", { priceOn: "2026-10-01" });
    expect((await listManualPositions(db))[0]).toMatchObject({ symbol: "ZQC", quantity: "0.5", unitPrice: "40000", priceOn: "2026-10-01", valueCents: 2_000_000 });
    const history = await db.select().from(balanceSnapshots).where(eq(balanceSnapshots.accountId, wallet));
    expect(history.map((h) => [h.on, h.balanceCents])).toEqual([[day, 2_000_000]]);
  });

  it("refuses a duplicate symbol, a zero quantity, a liability, a synced account, and a typed-over value", async () => {
    await add("ZQC", "0.5", "40000");
    await expect(add("zqc", "1", "1")).rejects.toThrow(/already/);
    await expect(add("BLX", "0", "1")).rejects.toThrow(/positive/);
    await expect(add("BLX", "-1", "1")).rejects.toThrow(/positive/);
    await expect(run("accounts.setManualValue", { accountId: wallet, valueCents: 5, on: day })).rejects.toThrow(/positions/);
    await expect(run("accounts.update", { accountId: wallet, kind: "loan" })).rejects.toThrow(/asset/);

    const loan = (await run("accounts.createManual", { name: "Loan", kind: "loan", valueCents: 100, on: day })).output.id;
    await expect(run("holdings.addManual", { accountId: loan, symbol: "ZQC", quantity: "1", unitPrice: "1" })).rejects.toThrow(/asset account/);
    const [synced] = await db.insert(accounts).values({ name: "Brokerage", institution: "Example", type: "brokerage", source: "simplefin", externalId: "x" }).returning();
    await expect(run("holdings.addManual", { accountId: synced.id, symbol: "ZQC", quantity: "1", unitPrice: "1" })).rejects.toThrow(/manual/);
  });

  it("removes positions with their account, and undo brings both back", async () => {
    await add("ZQC", "0.5", "40000");
    const removed = await run("accounts.deleteManual", { accountId: wallet });
    expect(await db.select().from(manualPositions)).toEqual([]);
    await undoCommand(db, removed.commandId, { actor: "user", reason: "test" });
    expect((await listManualPositions(db)).map((p) => p.symbol)).toEqual(["ZQC"]);
  });

  it("is the owner's alone: Tally can't write positions, and no read exposes them", async () => {
    await expect(run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "1", unitPrice: "1" }, "tally")).rejects.toThrow();
    const holdings = describeOperations().filter((op) => op.name.startsWith("holdings."));
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.every((op) => op.kind === "write")).toBe(true);
    // What a write returns carries an id, never a quantity or value.
    expect((await add("ZQC", "0.5", "40000")).output).toEqual({ id: expect.any(String) });
  });
});
