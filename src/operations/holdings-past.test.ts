import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, dailyPrices, quotes, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillPricesIfDue } from "@/lib/prices/backfill";
import { rebuiltHistory } from "@/lib/prices/rebuilt";
import type { PriceSource } from "@/lib/prices/source";
import { testDb } from "@/lib/test-utils/db";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { listManualPositions } from "@/operations/holdings";
import { execute, undoCommand } from "@/operations/runtime";

// What a hand-entered position held in the past (#340): since when, and
// prices of the owner's own where no market feed prices it. Invented coins,
// quantities and prices.

let db: Db;
let wallet: string;
const today = new Date().toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: { id: string } }>;
const position = async (symbol: string) => (await listManualPositions(db)).find((p) => p.symbol === symbol)!;
const history = async () => (await rebuiltHistory(db, today)).accounts.find((a) => a.accountId === wallet);
/** A market feed for a coin: a quote with a price, and closes every day for a span. */
async function covered(symbol: string, from: number, price = "100") {
  await db.insert(quotes).values({ assetClass: "crypto", symbol, price, source: "test", asOf: new Date(), checkedAt: new Date() });
  await db.insert(dailyPrices).values(Array.from({ length: from + 1 }, (_, i) => ({ assetClass: "crypto" as const, symbol, on: ago(from - i), price, source: "test" })));
}

beforeEach(async () => {
  db = await testDb();
  wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: today })).output.id;
});

describe("held since", () => {
  it("starts a covered coin's history on that day, valued at each day's price", async () => {
    await covered("ZQC", 120);
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(90) });
    const h = (await history())!;
    expect(h.coverageStart).toBe(ago(90));
    expect(h.values.filter((v) => v !== null).every((v) => v === 20_000)).toBe(true);
    // The market feed prices it, so none of the owner's prices are kept.
    expect((await position("ZQC")).pastPrices).toEqual([]);
  });

  it("moves when changed, and one undo puts it back", async () => {
    await covered("ZQC", 120);
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(30) });
    const moved = await run("holdings.setHeldSince", { positionId: (await position("ZQC")).id, heldSince: ago(60) });
    expect((await position("ZQC")).heldSince).toBe(ago(60));
    expect((await history())!.coverageStart).toBe(ago(60));
    await undoCommand(db, moved.commandId);
    expect((await position("ZQC")).heldSince).toBe(ago(30));
  });

  it("can't move after a sale it paid for, and doesn't change today's quantity", async () => {
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(30) });
    await run("trades.add", { accountId: wallet, on: ago(20), symbol: "ZQC", side: "sell", quantity: "1" });
    const { id } = await position("ZQC");
    await expect(run("holdings.setHeldSince", { positionId: id, heldSince: ago(10) })).rejects.toThrow(/after a sale/);
    await run("holdings.setHeldSince", { positionId: id, heldSince: ago(25) });
    expect((await position("ZQC")).quantity).toBe("1");
  });
});

describe("a back-dated buy", () => {
  it("adds to today's quantity, which stays what the trades replay to", async () => {
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(30) });
    await run("trades.add", { accountId: wallet, on: ago(60), symbol: "ZQC", side: "buy", quantity: "0.5", price: "80" });
    expect((await position("ZQC")).quantity).toBe("2.5");
    const log = await confirmedTrades(db, eq(trades.accountId, wallet));
    expect(log.map((t) => t.quantity).sort()).toEqual(["0.5", "2"]);
  });
});

describe("prices of the owner's own", () => {
  it("value an unpriced coin from the latest earlier one, and draw nothing before the first", async () => {
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQNEW", quantity: "10", unitPrice: "3", priceOn: ago(5), heldSince: ago(40) });
    const { id } = await position("ZQNEW");
    await run("holdings.setPastPrice", { positionId: id, on: ago(30), price: "1" });
    await run("holdings.setPastPrice", { positionId: id, on: ago(20), price: "2" });
    expect((await position("ZQNEW")).pastPrices).toEqual([
      { on: ago(30), price: "1" },
      { on: ago(20), price: "2" },
      { on: ago(5), price: "3" },
    ]);
    const h = (await history())!;
    const days = (await rebuiltHistory(db, today)).days;
    const valueOn = (day: string) => h.values[days.indexOf(day)];
    expect(h.coverageStart).toBe(ago(30));
    expect(valueOn(ago(35))).toBeNull();
    expect(valueOn(ago(25))).toBe(1_000);
    // Carried much further than a market close would be.
    expect(valueOn(ago(10))).toBe(2_000);
    expect(valueOn(today)).toBe(3_000);
  });

  it("replace a day's price, can be removed, and undo", async () => {
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQNEW", quantity: "10", unitPrice: "3" });
    const { id } = await position("ZQNEW");
    await run("holdings.setPastPrice", { positionId: id, on: ago(30), price: "1" });
    await run("holdings.setPastPrice", { positionId: id, on: ago(30), price: "1.5" });
    const removed = await run("holdings.removePastPrice", { positionId: id, on: ago(30) });
    expect((await position("ZQNEW")).pastPrices.map((p) => p.on)).toEqual([today]);
    await undoCommand(db, removed.commandId);
    expect((await position("ZQNEW")).pastPrices[0]).toEqual({ on: ago(30), price: "1.5" });
  });

  it("are refused for a coin the market prices", async () => {
    await covered("ZQC", 5);
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100" });
    await expect(run("holdings.setPastPrice", { positionId: (await position("ZQC")).id, on: ago(30), price: "90" })).rejects.toThrow(/market prices/);
  });

  it("don't stop the price backfill from reaching back before them", async () => {
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQNEW", quantity: "10", unitPrice: "3", priceOn: ago(5), heldSince: ago(40) });
    const asked: { from: string; to: string }[] = [];
    const source: PriceSource = {
      id: "test",
      assetClass: "crypto",
      quote: async () => [],
      history: async (_symbol, from, to) => {
        asked.push({ from, to });
        return [];
      },
    };
    await backfillPricesIfDue(db, { sources: [source] });
    expect(asked).toEqual([{ from: ago(40), to: ago(1) }]);
  });
});

describe("a value-only manual account", () => {
  it("still takes past values, as before", async () => {
    const car = (await run("accounts.createManual", { name: "Example car", kind: "other_asset", valueCents: 1_000_000, on: today })).output.id;
    await run("accounts.setManualValue", { accountId: car, valueCents: 1_200_000, on: ago(90) });
    const [row] = await db.select().from(accounts).where(eq(accounts.id, car));
    expect(row.balanceCents).toBe(1_000_000);
  });
});
