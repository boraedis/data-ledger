import { beforeEach, describe, expect, it } from "vitest";
import { intradayPrices, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { coinbaseSource } from "@/lib/prices/coinbase";
import { backfillHourlyIfDue, HOURLY_DAYS } from "@/lib/prices/hourly";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// Hourly crypto prices (#243), from a fake Coinbase. Invented coins and prices.

const HOUR = 3_600_000;
const now = new Date("2026-11-04T15:30:00Z");
let db: Db;
let asked: string[];

/** A Coinbase that answers candles for every hour asked, at a price of 100 + the hour of day. */
const fakeFetch = async (url: string) => {
  asked.push(url);
  const u = new URL(url);
  const start = Date.parse(u.searchParams.get("start")!);
  const end = Date.parse(u.searchParams.get("end")!);
  const rows = [];
  for (let t = end; t >= start; t -= HOUR) rows.push([t / 1000, 1, 2, 1.5, 100 + new Date(t).getUTCHours(), 10]);
  return new Response(JSON.stringify(rows), { status: 200 });
};
const sources = () => [coinbaseSource(fakeFetch, () => now)];

async function hold(symbol: string, on: string, quoted = true) {
  const wallet = (await execute(db, { operation: "accounts.createManual", input: { name: `${symbol} wallet`, kind: "other_asset", valueCents: 0, on: "2026-11-04" }, actor: "user", reason: "test" })) as { output: { id: string } };
  if (quoted) await db.insert(quotes).values({ assetClass: "crypto", symbol, price: "100", source: "coinbase", asOf: now, checkedAt: now });
  await execute(db, { operation: "holdings.addManual", input: { accountId: wallet.output.id, symbol, quantity: "1", unitPrice: "100", heldSince: on, today: "2026-11-04" }, actor: "user", reason: "test" });
}
const stored = async () => (await db.select().from(intradayPrices)).map((r) => r.hour.toISOString()).sort();

beforeEach(async () => {
  db = await testDb();
  asked = [];
});

describe("the Coinbase hourly source", () => {
  it("asks for the pair and the window only, 300 hours at a time, and keeps each hour's close", async () => {
    const closes = await coinbaseSource(fakeFetch, () => now).hourly!("zqc", new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T02:00:00Z"));
    expect(asked).toEqual(["https://api.exchange.coinbase.com/products/ZQC-USD/candles?granularity=3600&start=2026-11-01T00:00:00.000Z&end=2026-11-01T02:00:00.000Z"]);
    expect(closes).toEqual([
      { hour: "2026-11-01T00:00:00.000Z", price: "100" },
      { hour: "2026-11-01T01:00:00.000Z", price: "101" },
      { hour: "2026-11-01T02:00:00.000Z", price: "102" },
    ]);
    asked = [];
    await coinbaseSource(fakeFetch, () => now).hourly!("ZQC", new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    expect(asked).toHaveLength(3);
  });
});

describe("backfillHourlyIfDue", () => {
  it("fills a held coin's window in one go, then asks for nothing it has", async () => {
    await hold("ZQC", "2026-11-03");
    expect(await backfillHourlyIfDue(db, { now, sources: sources() })).toMatchObject({ symbols: 1, failed: 0 });
    const hours = await stored();
    expect(hours[0]).toBe("2026-11-03T00:00:00.000Z");
    // Through the last complete hour.
    expect(hours.at(-1)).toBe("2026-11-04T14:00:00.000Z");
    asked = [];
    expect(await backfillHourlyIfDue(db, { now, sources: sources() })).toEqual({ symbols: 0, added: 0, failed: 0 });
    expect(asked).toEqual([]);
  });

  it("asks only for what's new an hour later, and only for what's earlier when held from further back", async () => {
    await hold("ZQC", "2026-11-03");
    await backfillHourlyIfDue(db, { now, sources: sources() });
    asked = [];
    await backfillHourlyIfDue(db, { now: new Date(now.getTime() + HOUR), sources: sources() });
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]).searchParams.get("start")).toBe("2026-11-04T15:00:00.000Z");

    // Its held-since moved back a day: only that day is fetched.
    await db.execute(`update trades set "on" = '2026-11-02'`);
    asked = [];
    await backfillHourlyIfDue(db, { now: new Date(now.getTime() + HOUR), sources: sources() });
    expect(asked.map((u) => [new URL(u).searchParams.get("start"), new URL(u).searchParams.get("end")])).toEqual([["2026-11-02T00:00:00.000Z", "2026-11-02T23:00:00.000Z"]]);
  });

  it("goes back no further than the hourly window, and leaves a coin with no quote alone", async () => {
    await hold("ZQC", "2025-01-01");
    await hold("ZQNEW", "2026-11-01", false);
    await backfillHourlyIfDue(db, { now, sources: sources() });
    const first = Date.parse((await stored())[0]);
    expect(now.getTime() - first).toBeLessThanOrEqual(HOURLY_DAYS * 86_400_000 + HOUR);
    expect(asked.every((u) => u.includes("/ZQC-USD/"))).toBe(true);
  });

  it("stores each hour once, however often a window is sent", async () => {
    const closes = [{ hour: "2026-11-01T00:00:00.000Z", price: "100" }];
    for (let i = 0; i < 2; i++) await execute(db, { operation: "market.storeHourly", input: { assetClass: "crypto", source: "test", symbol: "ZQC", closes }, actor: "market", reason: "test" });
    expect(await stored()).toEqual(["2026-11-01T00:00:00.000Z"]);
  });
});
