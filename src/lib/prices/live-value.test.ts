import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, holdingSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { investmentsSummary } from "@/lib/investments/summary";
import { netWorthSummary } from "@/lib/net-worth";
import { liveValue } from "@/lib/prices/live-value";
import { pricesNote } from "@/lib/prices/describe";
import type { Quote } from "@/lib/prices/quotes";
import { refreshPricesIfDue } from "@/lib/prices/refresh";
import type { PriceSource } from "@/lib/prices/source";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// Values between syncs (#230). Symbols, quantities, prices and balances are
// invented; prices come from a fake source, never the network.

const NOW = new Date();
const fresh = (price: string, asOf = NOW): Quote => ({ price, asOf, stale: false, source: "fake" });

describe("liveValue (#230)", () => {
  it("is cash and other, plus each position at its latest price", () => {
    // $1,000 balance: $800 in positions at the last sync, so $200 is cash and other.
    const positions = [
      { symbol: "ZQC", quantity: "2", lastValueCents: 50_000, assetClass: "crypto" as const },
      { symbol: "BLX", quantity: "10", lastValueCents: 30_000, assetClass: "crypto" as const },
    ];
    const v = liveValue(100_000, positions, new Map([["crypto", new Map([["ZQC", fresh("300")], ["BLX", fresh("35")]])]]));
    expect(v).toMatchObject({ cashAndOtherCents: 20_000, valueCents: 20_000 + 60_000 + 35_000, priced: 2, unpriced: [] });
  });

  it("leaves a position with no current price at its last value, and names it", () => {
    const old = new Date(NOW.getTime() - 3_600_000);
    const positions = [
      { symbol: "ZQC", quantity: "2", lastValueCents: 50_000, assetClass: "crypto" as const },
      { symbol: "BLX", quantity: "10", lastValueCents: 30_000, assetClass: "crypto" as const },
      { symbol: "QQQ", quantity: "1", lastValueCents: 5_000, assetClass: "crypto" as const },
    ];
    const quotes = new Map<string, Quote>([
      ["ZQC", fresh("300", old)],
      ["BLX", { price: "99", asOf: old, stale: true, source: "fake" }],
      ["QQQ", { price: null, asOf: null, stale: true, source: "fake" }],
    ]);
    const v = liveValue(85_000, positions, new Map([["crypto", quotes]]));
    expect(v).toMatchObject({ valueCents: 60_000 + 30_000 + 5_000, priced: 1, unpriced: ["BLX", "QQQ"], pricesAsOf: old });
    expect(pricesNote(v)).toMatch(/prices as of .* UTC · BLX, QQQ at last value, no current price/);
    expect(pricesNote({ ...v, priced: 0 })).toBe(" · not valued live: no current prices");
  });
});

describe("net worth between syncs (#230)", () => {
  let db: Db;
  const day = NOW.toISOString().slice(0, 10);
  const user = (operation: string, input: Record<string, unknown>) =>
    execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ output: { id: string } }>;
  const source = (zqc: string): PriceSource => ({
    id: "fake",
    assetClass: "crypto",
    quote: async (symbols) => symbols.map((symbol) => ({ symbol, price: zqc, asOf: NOW })),
  });
  let wallet: string;

  beforeEach(async () => {
    db = await testDb();
    wallet = (await user("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
    await user("holdings.addManual", { accountId: wallet, symbol: "ZQC", quantity: "0.5", unitPrice: "40000" });
  });

  it("moves with a price change, with no sync and no balance change", async () => {
    expect((await netWorthSummary(db)).netCents).toBe(2_000_000);
    const recorded = await db.select().from(balanceSnapshots).where(eq(balanceSnapshots.accountId, wallet));

    await refreshPricesIfDue(db, { now: NOW, sources: [source("44000")] });
    const summary = await netWorthSummary(db);
    expect(summary.netCents).toBe(2_200_000);
    expect(summary.accounts[0].live).toMatchObject({ priced: 1, unpriced: [], pricesAsOf: NOW });
    // Today's point on the chart is the live value; nothing was written.
    expect(summary.series.at(-1)).toMatchObject({ on: day, netCents: 2_200_000 });
    expect(summary.daily.byAccount[wallet].at(-1)).toBe(2_200_000);
    expect(await db.select().from(balanceSnapshots).where(eq(balanceSnapshots.accountId, wallet))).toEqual(recorded);
    expect((await db.select().from(accounts).where(eq(accounts.id, wallet)))[0].balanceCents).toBe(2_000_000);
  });

  it("keeps a synced brokerage at its balance while equities have no price source, and says so", async () => {
    const [broker] = await db
      .insert(accounts)
      .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
      .returning();
    await db.insert(holdingSnapshots).values({ accountId: broker.id, on: day, externalId: "zz", symbol: "ZZIX", description: "Zeta Index", shares: "10", marketValueCents: 800_000, currency: "USD" });
    const inv = await investmentsSummary(db);
    const account = inv.accounts.find((a) => a.id === broker.id)!;
    expect(account).toMatchObject({ valueCents: 1_000_000, cashAndOtherCents: 200_000 });
    expect(account.live).toMatchObject({ priced: 0, unpriced: ["ZZIX"] });
    expect(pricesNote(account.live)).toBe(" · not valued live: no current prices");
  });
});
