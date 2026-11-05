import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, dailyPrices, intradayPrices, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { netWorthSummary } from "@/lib/net-worth";
import { hourlyNetWorth } from "@/lib/net-worth-hourly";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// Net worth by the hour (#338): a cash account, a loan, a brokerage and a
// coin wallet, all invented, with invented balances and prices.

const HOUR = 3_600_000;
const now = new Date("2026-11-04T15:30:00Z");
const day = (n: number) => new Date(Date.parse("2026-11-04T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);
let db: Db;

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ output: { id: string } }>;
async function synced(name: string, type: "checking" | "brokerage", balances: [number, number][], currency = "USD") {
  const [{ id }] = await db
    .insert(accounts)
    .values({ name, institution: "Example Bank", type, source: "simplefin", externalId: name, balanceCents: balances.at(-1)![1], balanceAt: now, currency, countsTowardBudgets: type === "checking" })
    .returning({ id: accounts.id });
  await db.insert(balanceSnapshots).values(balances.map(([d, cents]) => ({ accountId: id, on: day(d), balanceCents: cents, balanceAt: new Date(`${day(d)}T12:00:00Z`) })));
  return id;
}
const series = async () => hourlyNetWorth(db, await netWorthSummary(db, { today: now }), { now });
const at = (points: { at: string; cents: number }[], iso: string) => points.find((p) => p.at === iso)?.cents;

beforeEach(async () => {
  db = await testDb();
  // Cash steps from $1,000 to $1,200 between yesterday and today; the brokerage holds an invented stock.
  await synced("Everyday Checking", "checking", [[2, 100_000], [1, 100_000], [0, 120_000]]);
  await synced("Index Fund Account", "brokerage", [[2, 500_000], [1, 510_000], [0, 505_000]]);
  await run("accounts.createManual", { name: "Example loan", kind: "loan", valueCents: 300_000, on: day(2) });
});

describe("with no crypto", () => {
  it("is each day's total across its hours, stepping only at the day boundary", async () => {
    const { points, cryptoFrom } = await series();
    expect(cryptoFrom).toBeNull();
    // Yesterday: 1,000 + 5,100 − 3,000, every hour, overnight included.
    const yesterday = points.filter((p) => p.at.startsWith(day(1)));
    expect(yesterday).toHaveLength(24);
    expect(new Set(yesterday.map((p) => p.cents))).toEqual(new Set([100_000 + 510_000 - 300_000]));
    // Today: the cash and the stock moved at midnight, and nothing in between.
    expect(at(points, `${day(0)}T00:00:00.000Z`)).toBe(120_000 + 505_000 - 300_000);
    expect(at(points, `${day(0)}T09:00:00.000Z`)).toBe(120_000 + 505_000 - 300_000);
  });

  it("ends on live net worth, and leaves an excluded account out", async () => {
    await synced("Euro Savings", "checking", [[1, 900_000]], "EUR");
    const summary = await netWorthSummary(db, { today: now });
    const { points } = await hourlyNetWorth(db, summary, { now });
    expect(points.at(-1)).toEqual({ at: "2026-11-04T15:00:00.000Z", cents: summary.netCents });
    expect(points.every((p) => p.cents < 900_000)).toBe(true);
  });
});

describe("with a coin", () => {
  beforeEach(async () => {
    const wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day(2) })).output.id;
    await db.insert(quotes).values({ assetClass: "crypto", symbol: "ZQC", price: "100", source: "coinbase", asOf: now, checkedAt: now });
    await db.insert(dailyPrices).values([0, 1, 2].map((d) => ({ assetClass: "crypto" as const, symbol: "ZQC", on: day(d), price: "100", source: "coinbase" })));
    // Overnight, 2 coins swing from $100 to $110 and back.
    const hours = Array.from({ length: 40 }, (_, i) => Date.parse(`${day(1)}T00:00:00Z`) + i * HOUR);
    await db.insert(intradayPrices).values(hours.map((t) => ({ assetClass: "crypto" as const, symbol: "ZQC", hour: new Date(t), price: new Date(t).getUTCHours() === 3 ? "110" : "100", source: "coinbase" })));
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: day(2), today: day(0) });
  });

  it("moves with the coin's hourly price overnight, around the day's value", async () => {
    const { points, cryptoFrom } = await series();
    expect(cryptoFrom).toBe(`${day(1)}T00:00:00.000Z`);
    const base = 100_000 + 510_000 - 300_000 + 20_000;
    expect(at(points, `${day(1)}T02:00:00.000Z`)).toBe(base);
    expect(at(points, `${day(1)}T03:00:00.000Z`)).toBe(base + 2_000);
    expect(at(points, `${day(1)}T04:00:00.000Z`)).toBe(base);
  });

  it("keeps the day's value where there's no hourly price, and still ends on live net worth", async () => {
    const summary = await netWorthSummary(db, { today: now });
    const { points } = await hourlyNetWorth(db, summary, { now });
    // The day before hourly prices start: flat at the daily value.
    expect(new Set(points.filter((p) => p.at.startsWith(day(2))).map((p) => p.cents)).size).toBe(1);
    expect(points.at(-1)!.cents).toBe(summary.netCents);
  });
});
