import { beforeEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { netWorthContribution, netWorthSeries, netWorthSummary } from "@/lib/net-worth";
import { testDb } from "@/lib/test-utils/db";

// All values invented.

describe("sign convention", () => {
  it("counts assets as reported and liabilities as owed, whichever sign the provider used", () => {
    expect(netWorthContribution("checking", 120_000)).toBe(120_000);
    expect(netWorthContribution("checking", -5_000)).toBe(-5_000); // overdrawn
    expect(netWorthContribution("brokerage", 900_000)).toBe(900_000);
    expect(netWorthContribution("credit", -50_000)).toBe(-50_000);
    expect(netWorthContribution("credit", 50_000)).toBe(-50_000);
    expect(netWorthContribution("loan", 1_000_000)).toBe(-1_000_000);
  });
});

describe("netWorthSeries", () => {
  const kinds = new Map([
    ["chk", "checking" as const],
    ["card", "credit" as const],
  ]);

  it("carries balances forward across days without a snapshot, through today", () => {
    const series = netWorthSeries(
      kinds,
      [
        { accountId: "chk", on: "2026-07-01", balanceCents: 100_000 },
        { accountId: "card", on: "2026-07-02", balanceCents: -30_000 },
        { accountId: "chk", on: "2026-07-04", balanceCents: 80_000 },
      ],
      "2026-07-05",
    );
    expect(series.map((p) => [p.on, p.assetsCents, p.liabilitiesCents, p.netCents])).toEqual([
      ["2026-07-01", 100_000, 0, 100_000],
      ["2026-07-02", 100_000, 30_000, 70_000],
      ["2026-07-03", 100_000, 30_000, 70_000],
      ["2026-07-04", 80_000, 30_000, 50_000],
      ["2026-07-05", 80_000, 30_000, 50_000],
    ]);
  });

  it("ignores snapshots of accounts left out of the totals, and is empty without history", () => {
    expect(netWorthSeries(kinds, [{ accountId: "other", on: "2026-07-01", balanceCents: 1 }], "2026-07-01")).toEqual([]);
    expect(netWorthSeries(kinds, [], "2026-07-01")).toEqual([]);
  });
});

describe("netWorthSummary", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });

  it("totals by kind, and lists other currencies and missing balances separately", async () => {
    const rows = await db
      .insert(accounts)
      .values([
        { name: "Checking", institution: "Example CU", type: "checking", source: "seed", balanceCents: 250_000 },
        { name: "Card", institution: "Example CU", type: "credit", source: "seed", balanceCents: 40_000 },
        { name: "Index Fund", institution: "Example Brokerage", type: "brokerage", source: "seed", balanceCents: 1_000_000 },
        { name: "Euro Savings", institution: "Example Bank", type: "savings", source: "seed", balanceCents: 5_000, currency: "EUR" },
        { name: "New", institution: "Example CU", type: "savings", source: "seed" },
      ])
      .returning();
    await db.insert(balanceSnapshots).values([
      { accountId: rows[0].id, on: "2026-07-01", balanceCents: 200_000 },
      { accountId: rows[1].id, on: "2026-07-01", balanceCents: 40_000 },
      { accountId: rows[3].id, on: "2026-07-01", balanceCents: 5_000 },
    ]);

    const summary = await netWorthSummary(db, { today: new Date("2026-07-02T09:00:00Z") });
    expect(summary).toMatchObject({ assetsCents: 1_250_000, liabilitiesCents: 40_000, netCents: 1_210_000 });
    expect(summary.byKind).toEqual([
      { kind: "brokerage", cents: 1_000_000, accounts: 1 },
      { kind: "checking", cents: 250_000, accounts: 1 },
      { kind: "credit", cents: -40_000, accounts: 1 },
    ]);
    expect(summary.excluded.map((e) => [e.account.name, e.reason])).toEqual([
      ["Euro Savings", "currency"],
      ["New", "no balance"],
    ]);
    // History has no euros in it either.
    expect(summary.series.map((p) => p.netCents)).toEqual([160_000, 160_000]);
  });
});
