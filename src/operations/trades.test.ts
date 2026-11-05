import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots, manualPositions, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { holdingsOn } from "@/lib/holdings/replay";
import { testDb } from "@/lib/test-utils/db";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { listManualPositions } from "@/operations/holdings";
import { execute, undoCommand } from "@/operations/runtime";
import { tradeCheck } from "@/operations/trades";

// The trade log (#247), in an empty ledger. Symbols, quantities and prices invented.

let db: Db;
let wallet: string;
type Out = { commandId: string; output: { id: string } };
const run = (operation: string, input: Record<string, unknown>, actor = "user") =>
  execute(db, { operation, input, actor: actor as "user", reason: "test" }) as Promise<Out>;
const day = new Date().toISOString().slice(0, 10);
const position = async (symbol: string) => (await listManualPositions(db)).find((p) => p.symbol === symbol);
const value = async (id = wallet) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0].balanceCents;
const tradesOf = async (id = wallet) => confirmedTrades(db, eq(trades.accountId, id));

beforeEach(async () => {
  db = await testDb();
  wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
});

describe("a manual account's positions follow its trades (#247)", () => {
  it("records an opening buy for a position, and a buy or sell of the difference when its quantity changes", async () => {
    const { output } = await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "0.5", unitPrice: "40000" });
    await run("holdings.setQuantity", { positionId: output.id, quantity: "0.75" });
    await run("holdings.setQuantity", { positionId: output.id, quantity: "0.6" });
    const log = await tradesOf();
    expect(log.map((t) => [t.side, t.quantity])).toEqual([
      ["buy", "0.5"],
      ["buy", "0.25"],
      ["sell", "0.15"],
    ]);
    expect(holdingsOn(log).get("ZQC")).toBe((await position("ZQC"))!.quantity);
  });

  it("creates, changes and removes positions from trades, and revalues the account", async () => {
    await run("trades.add", { accountId: wallet, on: "2026-03-01", symbol: "zqc", side: "buy", quantity: "1", price: "30000" });
    expect(await position("ZQC")).toMatchObject({ quantity: "1", unitPrice: "30000", priceOn: "2026-03-01" });
    expect(await value()).toBe(3_000_000);

    await run("trades.add", { accountId: wallet, on: "2026-04-01", symbol: "ZQC", side: "sell", quantity: "0.25" });
    expect((await position("ZQC"))!.quantity).toBe("0.75");
    await run("trades.add", { accountId: wallet, on: "2026-05-01", symbol: "ZQC", side: "transfer_out", quantity: "0.75" });
    expect(await position("ZQC")).toBeUndefined();
    expect(await value()).toBe(0);
  });

  it("refuses selling more than was held on any day, and a new symbol with no price", async () => {
    await run("trades.add", { accountId: wallet, on: "2026-03-01", symbol: "ZQC", side: "buy", quantity: "1", price: "30000" });
    await expect(run("trades.add", { accountId: wallet, on: "2026-02-01", symbol: "ZQC", side: "sell", quantity: "0.5" })).rejects.toThrow(/more ZQC than was held on 2026-02-01/);
    await expect(run("trades.add", { accountId: wallet, on: "2026-03-01", symbol: "BLX", side: "buy", quantity: "10" })).rejects.toThrow(/Give a price for BLX/);
    expect(await tradesOf()).toHaveLength(1);
  });

  it("makes adding, editing and removing a trade each one undoable command", async () => {
    const added = await run("trades.add", { accountId: wallet, on: "2026-03-01", symbol: "ZQC", side: "buy", quantity: "1", price: "30000" });
    const edited = await run("trades.update", { tradeId: added.output.id, quantity: "2" });
    expect((await position("ZQC"))!.quantity).toBe("2");
    const removed = await run("trades.remove", { tradeId: added.output.id });
    expect(await position("ZQC")).toBeUndefined();

    await undoCommand(db, removed.commandId, { actor: "user", reason: "test" });
    expect((await position("ZQC"))!.quantity).toBe("2");
    await undoCommand(db, edited.commandId, { actor: "user", reason: "test" });
    expect((await position("ZQC"))!.quantity).toBe("1");
    await undoCommand(db, added.commandId, { actor: "user", reason: "test" });
    expect(await tradesOf()).toEqual([]);
    expect(await position("ZQC")).toBeUndefined();
  });
});

describe("a synced brokerage's trades (#247)", () => {
  let broker: string;
  beforeEach(async () => {
    [{ id: broker }] = await db
      .insert(accounts)
      .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
      .returning({ id: accounts.id });
    await db.insert(holdingSnapshots).values([
      { accountId: broker, on: "2026-11-01", externalId: "zz", symbol: "ZZIX", description: "Zeta Index", shares: "8.25", marketValueCents: 600_000, currency: "USD" },
      { accountId: broker, on: "2026-11-01", externalId: "fd", symbol: "ZQFDX", description: "Quill Fund", shares: "100", marketValueCents: 200_000, currency: "USD" },
    ]);
  });

  it("builds the past without touching positions or value, and says where it doesn't add up", async () => {
    await run("trades.add", { accountId: broker, on: "2026-03-01", symbol: "ZZIX", side: "buy", quantity: "10" });
    await run("trades.add", { accountId: broker, on: "2026-05-01", symbol: "ZZIX", side: "sell", quantity: "1.75" });
    expect(await db.select().from(manualPositions)).toEqual([]);
    expect(await value(broker)).toBe(1_000_000);
    // ZZIX adds up; the fund has no trades yet.
    expect((await tradeCheck(db)).get(broker)).toEqual([{ symbol: "ZQFDX", synced: "100", traded: "0", difference: "-100" }]);

    await run("trades.add", { accountId: broker, on: "2026-02-01", symbol: "ZQFDX", side: "transfer_in", quantity: "100" });
    expect((await tradeCheck(db)).get(broker)).toBeUndefined();
  });

  it("refuses trades in a cash account, and from anyone but the owner", async () => {
    const [checking] = await db.insert(accounts).values({ name: "Everyday Checking", institution: "Example", type: "checking", source: "simplefin", externalId: "c1" }).returning();
    await expect(run("trades.add", { accountId: checking.id, on: "2026-03-01", symbol: "ZZIX", side: "buy", quantity: "1" })).rejects.toThrow(/brokerage or retirement/);
    await expect(run("trades.add", { accountId: broker, on: "2026-03-01", symbol: "ZZIX", side: "buy", quantity: "1" }, "tally")).rejects.toThrow();
  });
});

describe("the migration's opening trades (#247)", () => {
  it("turns each existing position into a buy dated the day it was entered", async () => {
    await db.insert(manualPositions).values({ accountId: wallet, symbol: "zqc", quantity: "0.5", unitPrice: "40000", priceOn: "2026-10-01", createdAt: new Date("2026-10-02T23:30:00Z") });
    const migration = readFileSync("drizzle/0035_trade_log.sql", "utf8").split("--> statement-breakpoint").at(-1)!;
    await db.execute(sql.raw(migration));
    expect((await tradesOf()).map((t) => [t.on, t.symbol, t.side, t.quantity, t.price])).toEqual([["2026-10-02", "ZQC", "buy", "0.5", "40000"]]);
  });
});
