import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { manualPositions } from "@/db/schema";
import type { Db } from "@/db/types";
import { coinbaseSource } from "@/lib/prices/coinbase";
import { liveValues } from "@/lib/prices/live-value";
import { refreshPricesIfDue } from "@/lib/prices/refresh";
import type { PriceSource } from "@/lib/prices/source";
import { tiingoSource } from "@/lib/prices/tiingo";
import { testDb } from "@/lib/test-utils/db";
import { listManualPositions } from "@/operations/holdings";
import { execute, undoCommand } from "@/operations/runtime";

// What kind of asset a hand-entered position is (#244). Symbols, quantities
// and prices invented; providers are fakes.

let db: Db;
let wallet: string;
const day = new Date().toISOString().slice(0, 10);
const NOW = new Date();
const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: { id: string } }>;

beforeEach(async () => {
  db = await testDb();
  wallet = (await run("accounts.createManual", { name: "Mixed account", kind: "other_asset", valueCents: 0, on: day })).output.id;
  await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "1", unitPrice: "30000" });
  await run("holdings.addManual", { accountId: wallet, symbol: "ZZIX", quantity: "10", unitPrice: "100", assetClass: "equity" });
});

/** A fake source of one class that prices everything at `price`, recording what it was asked. */
function fake(assetClass: "crypto" | "equity", price: string) {
  const asked: string[] = [];
  const source: PriceSource = {
    id: `fake-${assetClass}`,
    assetClass,
    quote: async (symbols) => {
      asked.push(...symbols);
      return symbols.map((symbol) => ({ symbol, price, asOf: NOW }));
    },
  };
  return { source, asked };
}

describe("a hand-entered position's kind of asset (#244)", () => {
  it("is asked of the source for its kind: the coin of Coinbase, the stock of Tiingo", async () => {
    const coins = fake("crypto", "33000");
    const stocks = fake("equity", "110");
    await refreshPricesIfDue(db, { now: NOW, sources: [coins.source, stocks.source] });
    expect(coins.asked).toEqual(["ZQC"]);
    expect(stocks.asked).toEqual(["ZZIX"]);
    // Valued live at each one's own price: 1 × $33,000 + 10 × $110.
    expect((await liveValues(db, { now: NOW })).get(wallet)).toMatchObject({ valueCents: 3_300_000 + 110_000, priced: 2 });
  });

  it("never sends Coinbase an equity ticker, or Tiingo a coin", async () => {
    const urls: string[] = [];
    const record = async (url: string) => {
      urls.push(url);
      return new Response("not found", { status: 404 });
    };
    await refreshPricesIfDue(db, { now: NOW, sources: [coinbaseSource(record), tiingoSource("test-key-not-real", record)] });
    expect(urls.filter((u) => u.includes("coinbase")).every((u) => u.includes("ZQC") && !u.includes("ZZIX"))).toBe(true);
    expect(urls.filter((u) => u.includes("tiingo")).every((u) => u.includes("zzix") && !u.includes("zqc"))).toBe(true);
    expect(urls.some((u) => u.includes("coinbase"))).toBe(true);
    expect(urls.some((u) => u.includes("tiingo"))).toBe(true);
  });

  it("keeps the owner's price, and names the position, when its kind has no quote", async () => {
    // Coins priced; no equity source (no Tiingo key).
    await refreshPricesIfDue(db, { now: NOW, sources: [fake("crypto", "33000").source] });
    expect((await liveValues(db, { now: NOW })).get(wallet)).toMatchObject({ valueCents: 3_300_000 + 100_000, priced: 1, unpriced: ["ZZIX"] });
  });

  it("can be changed, logged and undoably", async () => {
    const zzix = (await listManualPositions(db)).find((p) => p.symbol === "ZZIX")!;
    const changed = await run("holdings.setAssetClass", { positionId: zzix.id, assetClass: "crypto" });
    expect((await listManualPositions(db)).find((p) => p.symbol === "ZZIX")!.assetClass).toBe("crypto");
    await undoCommand(db, changed.commandId, { actor: "user", reason: "test" });
    expect((await listManualPositions(db)).find((p) => p.symbol === "ZZIX")!.assetClass).toBe("equity");
    await expect(run("holdings.setAssetClass", { positionId: zzix.id, assetClass: "equity" })).rejects.toThrow(/already/);
  });

  it("leaves positions from before it as crypto, as they were priced", async () => {
    const [row] = await db
      .insert(manualPositions)
      .values({ accountId: wallet, symbol: "OLD", quantity: "1", unitPrice: "1", priceOn: day })
      .returning();
    expect((await db.select().from(manualPositions).where(eq(manualPositions.id, row.id)))[0].assetClass).toBe("crypto");
  });

  it("is taken from the trade for a symbol new to the account", async () => {
    await run("trades.add", { accountId: wallet, on: day, symbol: "ZQFDX", side: "buy", quantity: "5", price: "20", assetClass: "equity" });
    expect((await listManualPositions(db)).find((p) => p.symbol === "ZQFDX")!.assetClass).toBe("equity");
  });
});
