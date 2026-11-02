import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { investmentsSummary } from "@/lib/investments/summary";
import { latestQuotes } from "@/lib/prices/quotes";
import { refreshPricesIfDue, usMarketOpen } from "@/lib/prices/refresh";
import { tiingoDailyUrl, tiingoIexUrl, tiingoSource } from "@/lib/prices/tiingo";
import { testDb } from "@/lib/test-utils/db";

// Equity and fund prices from Tiingo (#229) against a fake server: no request
// leaves the test, and the key is invented. Tickers and prices are invented.

const KEY = "test-key-not-real";
// Monday 2 November 2026: 10:00 ET (market open), and 17:00 ET (closed).
const OPEN = new Date("2026-11-02T15:00:00Z");
const CLOSED = new Date("2026-11-02T22:00:00Z");
const after = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000);

type Route = (url: string) => Response;
function server(routes: Record<string, Route>) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    return route ? route(url) : new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { fetchImpl, calls };
}
const json = (body: unknown) => () => Response.json(body);

describe("the Tiingo source (#229)", () => {
  it("prices a listed stock from IEX, sending the key in a header and only the ticker in the URL", async () => {
    const { fetchImpl, calls } = server({ [tiingoIexUrl("ZZIX")]: json([{ ticker: "ZZIX", tngoLast: 123.45, last: null, timestamp: "2026-11-02T14:59:30+00:00" }]) });
    expect(await tiingoSource(KEY, fetchImpl).quote(["ZZIX"])).toEqual([{ symbol: "ZZIX", price: "123.45", asOf: new Date("2026-11-02T14:59:30Z") }]);
    expect(calls.map((c) => c.url)).toEqual(["https://api.tiingo.com/iex/zzix"]);
    expect(calls[0].headers.get("authorization")).toBe(`Token ${KEY}`);
    expect(calls[0].url).not.toContain(KEY);
  });

  it("falls back to the latest daily price for a fund not on IEX, marked daily", async () => {
    const { fetchImpl, calls } = server({
      [tiingoIexUrl("ZQFDX")]: json([]),
      [tiingoDailyUrl("ZQFDX")]: json([{ date: "2026-10-30T00:00:00.000Z", close: 41.07, adjClose: 41.07 }]),
    });
    expect(await tiingoSource(KEY, fetchImpl).quote(["ZQFDX"])).toEqual([{ symbol: "ZQFDX", price: "41.07", asOf: new Date("2026-10-30T00:00:00Z"), daily: true }]);
    expect(calls.map((c) => c.url)).toEqual(["https://api.tiingo.com/iex/zqfdx", "https://api.tiingo.com/tiingo/daily/zqfdx/prices"]);
  });

  it("reads an unknown ticker as no price, and a server error as a failed request", async () => {
    const { fetchImpl } = server({ [tiingoIexUrl("BUSY")]: () => new Response("busy", { status: 503 }) });
    expect(await tiingoSource(KEY, fetchImpl).quote(["NOPE", "BUSY"])).toEqual([
      { symbol: "NOPE", price: null },
      { symbol: "BUSY", failed: true },
    ]);
  });

  it("writes a tiny price out in full rather than in exponent form", async () => {
    const { fetchImpl } = server({ [tiingoIexUrl("TINY")]: json([{ tngoLast: 0.0000001, timestamp: "2026-11-02T14:59:30Z" }]) });
    expect(await tiingoSource(KEY, fetchImpl).quote(["TINY"])).toMatchObject([{ price: "0.0000001" }]);
  });
});

describe("usMarketOpen", () => {
  it("is the regular session on weekdays, in Eastern time", () => {
    expect([OPEN, CLOSED, new Date("2026-11-02T14:29:00Z"), new Date("2026-11-07T16:00:00Z")].map(usMarketOpen)).toEqual([true, false, false, false]);
    // Summer time: 9:30 ET is 13:30 UTC.
    expect(usMarketOpen(new Date("2026-07-01T13:31:00Z"))).toBe(true);
  });
});

describe("pricing a synced brokerage (#229, #230)", () => {
  let db: Db;
  let broker: string;
  beforeEach(async () => {
    db = await testDb();
    [{ id: broker }] = await db
      .insert(accounts)
      .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
      .returning({ id: accounts.id });
    await db.insert(holdingSnapshots).values([
      { accountId: broker, on: "2026-11-01", externalId: "zz", symbol: "ZZIX", description: "Zeta Index", shares: "10", marketValueCents: 600_000, currency: "USD" },
      { accountId: broker, on: "2026-11-01", externalId: "fd", symbol: "ZQFDX", description: "Quill Fund", shares: "100", marketValueCents: 200_000, currency: "USD" },
    ]);
  });
  const routes = (zzix: number) => ({
    [tiingoIexUrl("ZZIX")]: json([{ tngoLast: zzix, timestamp: "2026-11-02T14:59:30Z" }]),
    [tiingoIexUrl("ZQFDX")]: json([]),
    [tiingoDailyUrl("ZQFDX")]: json([{ date: "2026-10-30T00:00:00.000Z", close: 21 }]),
  });

  it("values the brokerage live: stocks intraday, the fund at its daily price", async () => {
    const { fetchImpl } = server(routes(660));
    await refreshPricesIfDue(db, { now: OPEN, sources: [tiingoSource(KEY, fetchImpl)] });
    const quotes = await latestQuotes(db, "equity", { now: OPEN });
    // The fund's Friday price is three days old, and still current: it's a daily price.
    expect(quotes.get("ZQFDX")).toMatchObject({ price: "21", stale: false, source: "tiingo:daily" });
    const account = (await investmentsSummary(db, { today: OPEN })).accounts.find((a) => a.id === broker)!;
    // $2,000 cash and other + 10 × $660 + 100 × $21.
    expect(account.valueCents).toBe(200_000 + 660_000 + 210_000);
    expect(account.live).toMatchObject({ priced: 2, unpriced: [] });
  });

  it("asks hourly while the market's open, and only every half day for funds or when it's closed", async () => {
    const { fetchImpl, calls } = server(routes(660));
    const sources = [tiingoSource(KEY, fetchImpl)];
    await refreshPricesIfDue(db, { now: OPEN, sources });
    calls.length = 0;
    await refreshPricesIfDue(db, { now: after(OPEN, 61), sources });
    // The stock again; the fund's daily price isn't due for 12 hours.
    expect(calls.map((c) => c.url)).toEqual([tiingoIexUrl("ZZIX")]);

    calls.length = 0;
    expect(await refreshPricesIfDue(db, { now: after(CLOSED, 61), sources })).toEqual({ status: "fresh" });
    expect(calls).toEqual([]);
  });

  it("asks nothing about equities without a Tiingo key", async () => {
    delete process.env.TIINGO_API_KEY;
    // No sources passed: the defaults, which leave Tiingo out with no key. Crypto has nothing held here.
    expect(await refreshPricesIfDue(db, { now: OPEN })).toEqual({ status: "fresh" });
  });
});
