import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, dailyPrices, holdingSnapshots, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { accountCash, projectCash } from "@/lib/investments/cash-history";
import { replayedSnapshots } from "@/lib/prices/rebuilt";
import { testDb } from "@/lib/test-utils/db";

// All invented: an account with one fund, a sweep fund, a deposit and a buy.

describe("projectCash", () => {
  it("walks the cash back through what posted, day by day", () => {
    const p = projectCash({
      anchorOn: "2026-05-01",
      anchorCents: 60_000,
      from: "2026-04-03",
      movements: [
        { on: "2026-04-10", cents: -100_000 },
        { on: "2026-04-05", cents: 158_000 },
        { on: "2026-05-01", cents: 2_000 },
      ],
    });
    const at = (on: string) => p.days.find((d) => d.on === on)?.cents;
    // The anchor day's own rows are already in its cash.
    expect(at("2026-04-30")).toBe(58_000);
    expect(at("2026-04-10")).toBe(58_000);
    expect(at("2026-04-09")).toBe(158_000);
    expect(at("2026-04-05")).toBe(158_000);
    expect(at("2026-04-04")).toBe(0);
    expect(p.days[0].on).toBe("2026-04-03");
  });

  it("leaves out every day up to the last one below zero, and says how much is missing", () => {
    const p = projectCash({ anchorOn: "2026-05-01", anchorCents: 1_000, from: "2026-04-01", movements: [{ on: "2026-04-20", cents: 5_000 }, { on: "2026-04-10", cents: 2_000 }] });
    // A $50 dividend on the 20th, but only $10 of cash after it: $40 came in unseen before the 19th.
    expect(p.days.map((d) => d.on)[0]).toBe("2026-04-20");
    expect(p.missing).toEqual({ cents: 6_000, by: "2026-04-19" });
    expect(p.start).toEqual({ on: "2026-04-20", cents: 1_000 });
  });

  it("reports the cash it starts from when every day is explained", () => {
    const p = projectCash({ anchorOn: "2026-05-01", anchorCents: 500, from: "2026-04-28", movements: [] });
    expect(p).toEqual({ days: [{ on: "2026-04-28", cents: 500 }, { on: "2026-04-29", cents: 500 }, { on: "2026-04-30", cents: 500 }], missing: null, start: { on: "2026-04-28", cents: 500 } });
  });
});

describe("a synced brokerage's past", () => {
  let db: Db;
  let broker: string;
  const snap = (accountId: string, on: string, symbol: string, shares: string, marketValueCents: number, description = `${symbol} Example Fund`) =>
    db.insert(holdingSnapshots).values({ accountId, on, externalId: symbol, symbol, description, shares, marketValueCents, currency: "USD" });

  beforeEach(async () => {
    db = await testDb();
    [{ id: broker }] = await db
      .insert(accounts)
      .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 160_000, countsTowardBudgets: false })
      .returning({ id: accounts.id });
    // First sync, May 1: 10 ZQXV worth $1,000, a $500 sweep fund, and $600 of cash in all.
    await db.insert(balanceSnapshots).values({ accountId: broker, on: "2026-05-01", balanceCents: 160_000 });
    await snap(broker, "2026-05-01", "ZQXV", "10", 100_000);
    await snap(broker, "2026-05-01", "ZMMF", "500", 50_000, "Example Money Market");
    // Before it: a $1,600 deposit on April 5 (by hand) and the $1,000 buy on April 10.
    await db.insert(trades).values({ accountId: broker, on: "2026-04-10", symbol: "ZQXV", side: "buy", quantity: "10", status: "confirmed", source: "hand" });
    await db.insert(transactions).values([
      { accountId: broker, postedOn: "2026-04-10", amountCents: -100_000, description: "YOU BOUGHT ZQXV", source: "import", externalId: "i1" },
      { accountId: broker, postedOn: "2026-04-20", amountCents: 7_000, description: "PURCHASE INTO CORE ACCOUNT", source: "import", externalId: "i2" },
    ]);
    const days = [];
    for (let d = Date.parse("2026-04-10T00:00:00Z"); d <= Date.parse("2026-05-01T00:00:00Z"); d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
    await db.insert(dailyPrices).values(days.map((on) => ({ assetClass: "equity" as const, symbol: "ZQXV", on, price: "100", source: "test" })));
  });

  it("anchors on the first balance with its positions, taking the sweep fund as cash", async () => {
    const [c] = await accountCash(db, "2026-04-10");
    expect(c).toMatchObject({ accountId: broker, anchorOn: "2026-05-01", recordedFrom: "2026-05-01", cashCents: 60_000 });
    // The sweep row moves money inside the cash, so it isn't a movement.
    expect(c.projection.days.find((d) => d.on === "2026-04-20")?.cents).toBe(60_000);
  });

  it("draws positions plus cash for the days before the first balance, once a deposit is added", async () => {
    // Without the deposit the walk says $1,600 of cash on April 9: the buy's cash came from somewhere.
    const before = await replayedSnapshots(db, "2026-05-01");
    expect(before.find((s) => s.on === "2026-04-10")).toMatchObject({ accountId: broker, balanceCents: 160_000 });
    expect(before.some((s) => s.on === "2026-05-01")).toBe(false);
    const [c] = await accountCash(db, "2026-04-04");
    expect(c.projection.start).toEqual({ on: "2026-04-04", cents: 160_000 });

    // Adding the deposit (a manual transaction, #64) explains it: nothing was there before April 5.
    await db.insert(transactions).values({ accountId: broker, postedOn: "2026-04-05", amountCents: 160_000, description: "Deposit", source: "manual" });
    const [after] = await accountCash(db, "2026-04-04");
    expect(after.projection.start).toEqual({ on: "2026-04-04", cents: 0 });
    expect(after.projection.missing).toBeNull();
  });

  it("skips an account whose positions are worth more than its balance, or that has no day with both", async () => {
    await db.update(balanceSnapshots).set({ balanceCents: 90_000 });
    expect(await accountCash(db, "2026-04-10")).toEqual([]);
    await db.delete(holdingSnapshots);
    await db.update(balanceSnapshots).set({ balanceCents: 160_000 });
    expect(await accountCash(db, "2026-04-10")).toEqual([]);
  });
});
