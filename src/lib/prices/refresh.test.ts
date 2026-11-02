import { beforeEach, describe, expect, it } from "vitest";
import { commandLog, dailyPrices } from "@/db/schema";
import type { Db } from "@/db/types";
import { coinbaseSource, coinbaseUrl } from "@/lib/prices/coinbase";
import { latestQuotes, refreshPricesIfDue } from "@/lib/prices/refresh";
import type { PriceSource, QuoteResult } from "@/lib/prices/source";
import { testDb } from "@/lib/test-utils/db";
import { execute, listCommands } from "@/operations/runtime";

// The market price cache (#229) against fake providers: no request leaves
// the test. Symbols, quantities and prices are invented.

let db: Db;
let wallet: string;
const T0 = new Date("2026-11-02T15:00:00Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const day = new Date().toISOString().slice(0, 10);
const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ output: { id: string } }>;

/** A fake crypto source answering from a table, recording what it was asked. */
function fake(answers: Record<string, string | null | "fail">) {
  const asked: string[][] = [];
  const source: PriceSource = {
    id: "fake",
    assetClass: "crypto",
    async quote(symbols) {
      asked.push(symbols);
      return symbols.map((symbol): QuoteResult => {
        const a = answers[symbol];
        return a === "fail" ? { symbol, failed: true } : a === null || a === undefined ? { symbol, price: null } : { symbol, price: a, asOf: T0 };
      });
    },
  };
  return { source, asked };
}

beforeEach(async () => {
  db = await testDb();
  wallet = (await user("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
  await user("holdings.addManual", { accountId: wallet, symbol: "zqc", quantity: "0.5", unitPrice: "40000" });
  await user("holdings.addManual", { accountId: wallet, symbol: "BLX", quantity: "1250", unitPrice: "0.08" });
});

describe("refreshing prices (#229)", () => {
  it("writes one command per refresh, and a second inside the hour asks nobody and writes nothing", async () => {
    const { source, asked } = fake({ ZQC: "41000.5", BLX: "0.09" });
    const first = await refreshPricesIfDue(db, { now: T0, sources: [source] });
    expect(first).toMatchObject({ status: "refreshed", priced: 2, unpriced: 0, failed: 0 });
    expect(asked).toEqual([["BLX", "ZQC"]]);
    expect((await listCommands(db, { limit: 50 })).filter((c) => c.operation === "market.refreshQuotes")).toHaveLength(1);

    expect(await refreshPricesIfDue(db, { now: later(59), sources: [source] })).toEqual({ status: "fresh" });
    expect(asked).toHaveLength(1);
    expect(await refreshPricesIfDue(db, { now: later(61), sources: [source] })).toMatchObject({ status: "refreshed" });
    expect(asked).toHaveLength(2);
  });

  it("stores the price and the day's price, and shows a symbol with no quote as no price, not zero", async () => {
    const { source } = fake({ ZQC: "41000.5", BLX: null });
    await refreshPricesIfDue(db, { now: T0, sources: [source] });
    const quotes = await latestQuotes(db, "crypto", { now: later(5) });
    expect(quotes.get("ZQC")).toMatchObject({ price: "41000.5", stale: false, source: "fake" });
    expect(quotes.get("BLX")).toMatchObject({ price: null });
    expect((await db.select().from(dailyPrices)).map((d) => [d.symbol, d.on, d.price])).toEqual([["ZQC", "2026-11-02", "41000.5"]]);
  });

  it("keeps the last price after a failed request, labels it stale with its time, and doesn't retry until it's due", async () => {
    await refreshPricesIfDue(db, { now: T0, sources: [fake({ ZQC: "41000.5", BLX: "0.09" }).source] });
    const down = fake({ ZQC: "fail", BLX: "fail" });
    expect(await refreshPricesIfDue(db, { now: later(90), sources: [down.source] })).toMatchObject({ status: "refreshed", failed: 2 });
    expect(await refreshPricesIfDue(db, { now: later(100), sources: [down.source] })).toEqual({ status: "fresh" });
    expect(down.asked).toHaveLength(1);

    const quotes = await latestQuotes(db, "crypto", { now: later(200) });
    expect(quotes.get("ZQC")).toMatchObject({ price: "41000.5", asOf: T0, stale: true });
  });

  it("asks nothing when nothing is held", async () => {
    const empty = await testDb();
    const { source, asked } = fake({});
    expect(await refreshPricesIfDue(empty, { now: T0, sources: [source] })).toEqual({ status: "fresh" });
    expect(asked).toEqual([]);
  });

  it("is the market actor's alone, and hidden from Activity unless asked for", async () => {
    await expect(
      execute(db, { operation: "market.refreshQuotes", actor: "user", reason: "test", input: { at: T0.toISOString(), batches: [{ assetClass: "crypto", source: "x", results: [{ symbol: "ZQC", price: null }] }] } }),
    ).rejects.toThrow();
    await refreshPricesIfDue(db, { now: T0, sources: [fake({ ZQC: "1", BLX: "1" }).source] });
    expect((await listCommands(db, { excludeActors: ["market"] })).some((c) => c.actor === "market")).toBe(false);
    expect((await db.select().from(commandLog)).some((c) => c.actor === "market")).toBe(true);
  });
});

describe("the Coinbase source (#229)", () => {
  it("asks for a pair name and nothing else: no quantity, no account", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect(init?.body).toBeUndefined();
      return Response.json({ data: { amount: "41000.5", base: "ZQC", currency: "USD" } });
    };
    await refreshPricesIfDue(db, { now: T0, sources: [coinbaseSource(fetchImpl, () => T0)] });
    expect(urls).toEqual([coinbaseUrl("BLX"), coinbaseUrl("ZQC")]);
    expect(urls).toEqual(["https://api.coinbase.com/v2/prices/BLX-USD/spot", "https://api.coinbase.com/v2/prices/ZQC-USD/spot"]);
    for (const url of urls) expect(url).not.toMatch(/0\.5|1250|40000|0\.08|\?|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("reads a 404 as no price, and an error or odd answer as a failed request", async () => {
    const answers: Record<string, () => Response> = {
      ZQC: () => new Response("not found", { status: 404 }),
      BLX: () => new Response("busy", { status: 503 }),
      QQQ: () => Response.json({ data: {} }),
    };
    const source = coinbaseSource(async (url) => answers[url.split("/").at(-2)!.replace("-USD", "")](), () => T0);
    expect(await source.quote(["ZQC", "BLX", "QQQ"])).toEqual([
      { symbol: "ZQC", price: null },
      { symbol: "BLX", failed: true },
      { symbol: "QQQ", failed: true },
    ]);
  });
});
