import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, holdingSnapshots, tradeKindMemory, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { testDb } from "@/lib/test-utils/db";
import { attachCashRows, draftTradeGaps } from "@/lib/trades/draft-gaps";
import { cashFlowSeries } from "@/operations/cashflow";
import { execute, read, undoCommand } from "@/operations/runtime";

// Changes in shares that aren't plain trades (#324): splits, reinvested
// dividends, share transfers between the owner's accounts, and a net change
// that was several trades. Invented brokerages, funds and amounts.

let db: Db;
let broker: string;
let other: string;

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: { id: string; ids?: string[] } }>;
async function account(name: string, externalId: string) {
  const [{ id }] = await db
    .insert(accounts)
    .values({ name, institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId, countsTowardBudgets: false })
    .returning({ id: accounts.id });
  return id;
}
async function snapshot(accountId: string, on: string, shares: string, valueCents = Math.round(Number(shares) * 12_500), symbol = "ZQXV") {
  await db.insert(holdingSnapshots).values({ accountId, on, externalId: symbol, symbol, description: "Example Growth Fund", shares, marketValueCents: valueCents, currency: "USD" });
}
const drafts = async (accountId = broker) => (await db.select().from(trades).where(eq(trades.accountId, accountId))).filter((t) => t.status === "draft");

beforeEach(async () => {
  db = await testDb();
  broker = await account("Index Fund Account", "b1");
  other = await account("Second Brokerage Account", "b2");
});

describe("a split", () => {
  it("is drafted as a 2-for-1 split, not a buy of 10, when the shares double and the value doesn't", async () => {
    await snapshot(broker, "2026-05-01", "10", 125_000);
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "20", 127_000);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => [t.kind, t.ratio, t.side, t.quantity])).toEqual([["split", "2", "buy", "10"]]);
  });

  it("isn't one when the value doubles with the shares: that's a buy", async () => {
    await snapshot(broker, "2026-05-01", "10", 125_000);
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "20", 250_000);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => t.kind)).toEqual(["trade"]);
  });

  it("can be said by hand, with its ratio, and isn't remembered", async () => {
    await snapshot(broker, "2026-05-01", "10");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "11");
    await draftTradeGaps(db);
    const [d] = await drafts();
    await expect(run("trades.setKind", { tradeId: d.id, kind: "split" })).rejects.toThrow(/ratio/);
    await run("trades.setKind", { tradeId: d.id, kind: "split", ratio: "1.1" });
    expect((await drafts())[0]).toMatchObject({ kind: "split", ratio: "1.1" });
    expect(await db.select().from(tradeKindMemory)).toEqual([]);
  });
});

describe("a transfer of shares", () => {
  it("pairs a sale in one account with a buy in another, so neither is a sale or a buy", async () => {
    for (const id of [broker, other]) await snapshot(id, "2026-05-01", id === broker ? "5" : "1");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "3");
    await snapshot(other, "2026-05-02", "3");
    await draftTradeGaps(db);
    const [out] = await drafts(broker);
    const [into] = await drafts(other);
    expect(out).toMatchObject({ kind: "transfer", side: "transfer_out", quantity: "2", pairedTradeId: into.id });
    expect(into).toMatchObject({ kind: "transfer", side: "transfer_in", quantity: "2", pairedTradeId: out.id });
  });

  it("finds its other end when the second account syncs a day later", async () => {
    for (const id of [broker, other]) await snapshot(id, "2026-05-01", id === broker ? "5" : "1");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "3");
    await draftTradeGaps(db);
    expect((await drafts(broker))[0]).toMatchObject({ kind: "trade", side: "sell" });
    await snapshot(other, "2026-05-03", "3");
    await draftTradeGaps(db);
    const [out] = await drafts(broker);
    const [into] = await drafts(other);
    expect([out.side, into.side, out.pairedTradeId, into.pairedTradeId]).toEqual(["transfer_out", "transfer_in", into.id, out.id]);
  });

  it("is unpaired at both ends when one is said to be a plain trade", async () => {
    for (const id of [broker, other]) await snapshot(id, "2026-05-01", id === broker ? "5" : "1");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-02", "3");
    await snapshot(other, "2026-05-02", "3");
    await draftTradeGaps(db);
    await run("trades.setKind", { tradeId: (await drafts(broker))[0].id, kind: "trade" });
    expect((await drafts(broker))[0]).toMatchObject({ kind: "trade", side: "sell", pairedTradeId: null });
    expect((await drafts(other))[0]).toMatchObject({ kind: "trade", side: "buy", pairedTradeId: null });
  });
});

describe("a reinvested dividend", () => {
  it("is recognized from its cash row, and is in nobody's cash flow", async () => {
    await snapshot(broker, "2026-05-01", "10");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-05", "10.1");
    await draftTradeGaps(db);
    const [{ id: cat }] = await db.insert(categories).values({ name: "Example income", kind: "income" }).returning({ id: categories.id });
    await db.insert(transactions).values([
      { accountId: broker, postedOn: "2026-05-04", amountCents: 1_250, description: "DIVIDEND RECEIVED ZQXV", externalId: "d1", categoryId: cat },
      { accountId: broker, postedOn: "2026-05-04", amountCents: -1_250, description: "DIVIDEND REINVESTMENT ZQXV", externalId: "d2" },
    ]);
    await attachCashRows(db);
    expect((await drafts())[0]).toMatchObject({ kind: "reinvestment", price: "125", on: "2026-05-04" });
    const flow = await read(db, cashFlowSeries, { from: "2026-05-01", to: "2026-05-31" });
    expect(flow.totals).toMatchObject({ inCents: 0, outCents: 0 });
  });

  it("said by hand is remembered, so the next one is drafted as a reinvestment", async () => {
    await snapshot(broker, "2026-05-01", "10");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-05", "10.1");
    await draftTradeGaps(db);
    const said = await run("trades.setKind", { tradeId: (await drafts())[0].id, kind: "reinvestment" });
    await snapshot(broker, "2026-08-05", "10.2");
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => t.kind)).toEqual(["reinvestment", "reinvestment"]);

    // Undoing the choice forgets it too.
    await db.delete(trades).where(eq(trades.on, "2026-08-05"));
    await undoCommand(db, said.commandId);
    expect(await db.select().from(tradeKindMemory)).toEqual([]);
  });
});

describe("a net change that was several trades", () => {
  beforeEach(async () => {
    await snapshot(broker, "2026-05-01", "10");
    await draftTradeGaps(db);
    await snapshot(broker, "2026-05-05", "13");
    await draftTradeGaps(db);
  });

  it("splits into parts that add up to it, and the gap stays closed", async () => {
    const [d] = await drafts();
    await expect(run("trades.splitDraft", { tradeId: d.id, parts: [{ quantity: "2" }, { quantity: "0.5" }] })).rejects.toThrow(/add up to 2.5, not 3/);
    const split = await run("trades.splitDraft", { tradeId: d.id, parts: [{ quantity: "2", on: "2026-05-03" }, { quantity: "1" }] });
    expect(split.output.ids).toHaveLength(2);
    expect((await drafts()).map((t) => [t.quantity, t.onFrom, t.on]).sort()).toEqual([
      ["1", "2026-05-02", "2026-05-05"],
      ["2", null, "2026-05-03"],
    ]);
    expect(await draftTradeGaps(db)).toBe(0);
  });

  it("is undone as one change", async () => {
    const [d] = await drafts();
    const split = await run("trades.splitDraft", { tradeId: d.id, parts: [{ quantity: "1.5" }, { quantity: "1.5" }] });
    await undoCommand(db, split.commandId);
    expect((await drafts()).map((t) => t.quantity)).toEqual(["3"]);
  });
});
