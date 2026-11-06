import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, commandLog, dailyPrices } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillPricesIfDue } from "@/lib/prices/backfill";
import { coinbaseCandlesUrl, coinbaseSource } from "@/lib/prices/coinbase";
import { rebuild, rebuiltHistory, type ClosePrice, type PricedTrade } from "@/lib/prices/rebuilt";
import type { DailyClose, PriceSource } from "@/lib/prices/source";
import { tiingoHistoryUrl } from "@/lib/prices/tiingo";
import { testDb } from "@/lib/test-utils/db";
import { listManualPositions } from "@/operations/holdings";
import { execute } from "@/operations/runtime";

// History rebuilt from trades and daily prices (#232). Symbols, quantities
// and prices are invented; providers are fakes.

const trade = (accountId: string, on: string, symbol: string, side: PricedTrade["side"], quantity: string): PricedTrade => ({ accountId, on, symbol, side, quantity });
const closes = (symbol: string, rows: [string, string][]): [string, ClosePrice[]] => [symbol, rows.map(([on, price]) => ({ symbol, on, price }))];

describe("rebuild (#232)", () => {
  it("values each day at that day's quantity and price, and never guesses either", () => {
    const h = rebuild(
      new Map([["a", [trade("a", "2026-03-02", "ZZIX", "buy", "10"), trade("a", "2026-03-04", "ZZIX", "sell", "4")]]]),
      new Map([closes("ZZIX", [["2026-03-03", "100"], ["2026-03-04", "110"], ["2026-03-11", "120"]])]),
      "2026-03-11",
    );
    expect(h.days[0]).toBe("2026-03-02");
    expect(h.accounts[0].values).toEqual([
      null, // 3-02: bought, but no price yet
      100_000, // 3-03: 10 × $100
      66_000, // 3-04: 6 × $110
      66_000, 66_000, 66_000, 66_000, // through 3-08: carried from 3-04, within four days
      null, null, // 3-09, 3-10: the last close is five days old, so unknown
      72_000, // 3-11: 6 × $120
    ]);
    expect(h.accounts[0].coverageStart).toBe("2026-03-03");
  });

  it("labels the total partial on any day not every account covers, and names where it's complete", () => {
    const h = rebuild(
      new Map([
        ["a", [trade("a", "2026-03-02", "ZZIX", "buy", "1")]],
        ["b", [trade("b", "2026-03-04", "ZQC", "buy", "2")]],
      ]),
      new Map([closes("ZZIX", [["2026-03-02", "10"], ["2026-03-03", "10"], ["2026-03-04", "10"]]), closes("ZQC", [["2026-03-04", "5"]])]),
      "2026-03-04",
    );
    expect(h.total.map((t) => [t.on, t.cents, t.complete])).toEqual([
      ["2026-03-02", 1_000, false],
      ["2026-03-03", 1_000, false],
      ["2026-03-04", 2_000, true],
    ]);
    expect(h.completeFrom).toBe("2026-03-04");
  });

  it("names what keeps an account from being valued: an unpriced symbol, or a sale with no buy", () => {
    const unpriced = rebuild(new Map([["a", [trade("a", "2026-03-02", "ZQXV", "buy", "2")]]]), new Map(), "2026-03-04");
    expect(unpriced.accounts[0]).toMatchObject({ coverageStart: null, blocker: { symbol: "ZQXV", reason: "no price" } });
    const short = rebuild(new Map([["a", [trade("a", "2026-03-02", "ZQXV", "sell", "2")]]]), new Map([closes("ZQXV", [["2026-03-02", "10"]])]), "2026-03-04");
    expect(short.accounts[0].blocker).toEqual({ symbol: "ZQXV", reason: "sold short" });
    const fine = rebuild(new Map([["a", [trade("a", "2026-03-02", "ZQXV", "buy", "2")]]]), new Map([closes("ZQXV", [["2026-03-02", "10"]])]), "2026-03-04");
    expect(fine.accounts[0].blocker).toBeNull();
  });

  it("treats selling more than a partial log shows as unknown, not negative wealth", () => {
    const h = rebuild(new Map([["a", [trade("a", "2026-03-02", "ZZIX", "sell", "1")]]]), new Map([closes("ZZIX", [["2026-03-02", "10"]])]), "2026-03-02");
    expect(h.accounts[0].values).toEqual([null]);
  });
});

describe("with the ledger (#232)", () => {
  let db: Db;
  let wallet: string;
  const day = new Date().toISOString().slice(0, 10);
  const user = (operation: string, input: Record<string, unknown>) =>
    execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ output: { id: string } }>;

  /** A fake crypto source whose history is a price per day, recording what it was asked. */
  function fakeHistory(price: (on: string) => string | null) {
    const asked: [string, string, string][] = [];
    const source: PriceSource = {
      id: "fake",
      assetClass: "crypto",
      quote: async () => [],
      history: async (symbol, from, to) => {
        asked.push([symbol, from, to]);
        const out: DailyClose[] = [];
        for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
          const p = price(d);
          if (p) out.push({ on: d, price: p });
        }
        return out;
      },
    };
    return { source, asked };
  }

  beforeEach(async () => {
    db = await testDb();
    wallet = (await user("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
    await user("trades.add", { accountId: wallet, on: "2026-09-01", symbol: "ZQC", side: "buy", quantity: "1", price: "30000" });
    await user("trades.add", { accountId: wallet, on: "2026-10-01", symbol: "ZQC", side: "buy", quantity: "0.5", price: "32000" });
  });

  it("fills in past prices back to the first trade, once per symbol, and isn't due again within the hour", async () => {
    // The real clock: "not due" is measured from the logged command's own time.
    const now = new Date();
    const { source, asked } = fakeHistory(() => "31000");
    expect(await backfillPricesIfDue(db, { now, sources: [source] })).toMatchObject({ status: "backfilled", symbols: 1 });
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    expect(asked).toEqual([["ZQC", "2026-09-01", yesterday]]);
    expect((await db.select().from(commandLog).where(eq(commandLog.operation, "market.backfillPrices"))).length).toBe(1);
    expect(await backfillPricesIfDue(db, { now: new Date(now.getTime() + 30 * 60_000), sources: [source] })).toEqual({ status: "not due" });
    // An hour on, nothing earlier than the first trade is missing.
    expect(await backfillPricesIfDue(db, { now: new Date(now.getTime() + 61 * 60_000), sources: [source] })).toEqual({ status: "nothing missing" });
  });

  it("never overwrites a day's recorded price", async () => {
    await db.insert(dailyPrices).values({ assetClass: "crypto", symbol: "ZQC", on: "2026-09-02", price: "99999", source: "refresh" });
    // The earliest recorded day is 9-02, so only 9-01 is fetched.
    const { source, asked } = fakeHistory(() => "31000");
    await backfillPricesIfDue(db, { now: new Date(`${day}T15:00:00Z`), sources: [source] });
    expect(asked).toEqual([["ZQC", "2026-09-01", "2026-09-01"]]);
    expect((await db.select().from(dailyPrices).where(eq(dailyPrices.on, "2026-09-02")))[0].price).toBe("99999");
  });

  it("rebuilds the account from its trades, ending at today's position", async () => {
    await backfillPricesIfDue(db, { now: new Date(`${day}T15:00:00Z`), sources: [fakeHistory((d) => (d < "2026-10-01" ? "30000" : "32000")).source] });
    const h = await rebuiltHistory(db, "2026-10-02");
    const account = h.accounts.find((a) => a.accountId === wallet)!;
    expect(account.coverageStart).toBe("2026-09-01");
    expect(account.values[0]).toBe(3_000_000);
    // Replaying the trades ends at the position the account holds today.
    const [position] = await listManualPositions(db);
    expect(position.quantity).toBe("1.5");
    expect(account.values.at(-1)).toBe(4_800_000);
    expect((await db.select().from(accounts).where(eq(accounts.id, wallet)))[0].balanceCents).not.toBeNull();
  });
});

describe("history requests (#232)", () => {
  it("carry the symbol and dates only", () => {
    expect(coinbaseCandlesUrl("zqc", "2026-01-01", "2026-03-01")).toBe(
      "https://api.exchange.coinbase.com/products/ZQC-USD/candles?granularity=86400&start=2026-01-01T00:00:00Z&end=2026-03-01T00:00:00Z",
    );
    expect(tiingoHistoryUrl("ZZIX", "2026-01-01", "2026-03-01")).toBe("https://api.tiingo.com/tiingo/daily/zzix/prices?startDate=2026-01-01&endDate=2026-03-01");
  });

  it("asks Coinbase in windows of 300 days, and reads a 404 as no such pair", async () => {
    const urls: string[] = [];
    const source = coinbaseSource(async (url) => {
      urls.push(url);
      const start = new URL(url).searchParams.get("start")!.slice(0, 10);
      return Response.json([[Date.parse(`${start}T00:00:00Z`) / 1000, 1, 2, 1, 1.5, 10]]);
    });
    const closes = await source.history!("ZQC", "2025-01-01", "2026-06-30");
    expect(urls).toHaveLength(2);
    expect(closes).toEqual([
      { on: "2025-01-01", price: "1.5" },
      { on: "2025-10-28", price: "1.5" },
    ]);
    const missing = coinbaseSource(async () => new Response("not found", { status: 404 }));
    expect(await missing.history!("NOPE", "2026-01-01", "2026-01-02")).toBeNull();
  });
});
