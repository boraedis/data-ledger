import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, dailyPrices, quotes } from "@/db/schema";
import type { Db } from "@/db/types";
import { investmentsSummary } from "@/lib/investments/summary";
import { netWorthSummary } from "@/lib/net-worth";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// A hand-entered position's past on the charts that draw recorded values
// (#343): Net worth's Over time and the account's chart on Investments.
// Invented coins, funds, quantities and prices.

let db: Db;
let wallet: string;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: { id: string } }>;

async function pricedDaily(symbol: string, days: number[], price: string) {
  await db.insert(quotes).values({ assetClass: "crypto", symbol, price, source: "test", asOf: now, checkedAt: now });
  await db.insert(dailyPrices).values(days.map((d) => ({ assetClass: "crypto" as const, symbol, on: ago(d), price, source: "test" })));
}

beforeEach(async () => {
  db = await testDb();
  wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: today })).output.id;
});

describe("a position held since a past day", () => {
  beforeEach(async () => {
    await pricedDaily("ZQC", Array.from({ length: 121 }, (_, i) => i), "100");
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(90) });
  });

  it("starts Net worth's Over time then, at quantity × price, and today's figures are unchanged", async () => {
    const summary = await netWorthSummary(db, { today: now });
    expect(summary.series[0]).toMatchObject({ on: ago(90), assetsCents: 20_000 });
    expect(summary.series.every((p) => p.assetsCents === 20_000)).toBe(true);
    expect(summary.daily.byAccount[wallet][0]).toBe(20_000);
    expect(summary.netCents).toBe(20_000);
  });

  it("starts the account's chart on Investments then too", async () => {
    const { accounts: listed } = await investmentsSummary(db, { today: now });
    const series = listed.find((a) => a.id === wallet)!.series;
    expect(series[0]).toMatchObject({ on: ago(90), cents: 20_000 });
  });
});

describe("what the replay can't value", () => {
  it("falls back to the recorded value on those days", async () => {
    // Prices for the first 10 days held and the last few only: the days between can't be valued.
    await pricedDaily("ZQC", [...Array.from({ length: 10 }, (_, i) => 60 - i), 2, 1, 0], "100");
    await run("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "2", unitPrice: "100", heldSince: ago(60) });
    await db.insert(balanceSnapshots).values({ accountId: wallet, on: ago(30), balanceCents: 15_000, balanceAt: new Date(`${ago(30)}T12:00:00Z`) });
    const summary = await netWorthSummary(db, { today: now });
    const on = (day: string) => summary.series.find((p) => p.on === day)!.assetsCents;
    expect(on(ago(60))).toBe(20_000);
    expect(on(ago(30))).toBe(15_000);
    expect(on(today)).toBe(20_000);
  });
});

describe("other accounts", () => {
  it("leave a synced brokerage and a value-only manual account as recorded", async () => {
    const [{ id: broker }] = await db
      .insert(accounts)
      .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 500_000, balanceAt: now, countsTowardBudgets: false })
      .returning({ id: accounts.id });
    await db.insert(balanceSnapshots).values([
      { accountId: broker, on: ago(10), balanceCents: 400_000, balanceAt: new Date(`${ago(10)}T12:00:00Z`) },
      { accountId: broker, on: today, balanceCents: 500_000, balanceAt: now },
    ]);
    await pricedDaily("ZQIX", Array.from({ length: 30 }, (_, i) => i), "50");
    await run("trades.add", { accountId: broker, on: ago(20), symbol: "ZQIX", side: "buy", quantity: "1" });
    const car = (await run("accounts.createManual", { name: "Example car", kind: "other_asset", valueCents: 1_000_000, on: today })).output.id;
    await run("accounts.setManualValue", { accountId: car, valueCents: 1_200_000, on: ago(40) });

    const { daily } = await netWorthSummary(db, { today: now });
    const valueOn = (id: string, day: string) => daily.byAccount[id][daily.days.indexOf(day)];
    expect(valueOn(broker, ago(10))).toBe(400_000);
    expect(valueOn(broker, ago(15))).toBeNull();
    expect(valueOn(car, ago(40))).toBe(1_200_000);
    expect(valueOn(car, today)).toBe(1_000_000);
    expect((await db.select().from(accounts).where(eq(accounts.id, car)))[0].balanceCents).toBe(1_000_000);
  });
});
