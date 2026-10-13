import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { dailySeries, investmentsSummary } from "@/lib/investments/summary";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// On the synthetic seed: one brokerage account with three invented funds,
// one without a cost basis. All values invented.

describe("dailySeries", () => {
  it("carries the balance forward through today and notes positions where recorded", () => {
    expect(
      dailySeries(
        [
          { on: "2026-07-01", cents: 100 },
          { on: "2026-07-03", cents: 130 },
        ],
        new Map([["2026-07-03", 120]]),
        "2026-07-04",
      ),
    ).toEqual([
      { on: "2026-07-01", cents: 100, holdingsCents: null },
      { on: "2026-07-02", cents: 100, holdingsCents: null },
      { on: "2026-07-03", cents: 130, holdingsCents: 120 },
      { on: "2026-07-04", cents: 130, holdingsCents: null },
    ]);
  });
});

describe("investmentsSummary", () => {
  let db: Db;
  const today = new Date("2026-06-30T15:00:00Z");
  beforeEach(async () => {
    db = await testDb();
    await applySeed(db, { endDate: today });
  });

  it("shows the brokerage's latest positions, cash, gains and allocation", async () => {
    const s = await investmentsSummary(db, { today });
    const [brokerage] = await db.select().from(accounts).where(eq(accounts.type, "brokerage"));
    expect(s.accounts).toHaveLength(1);
    const [a] = s.accounts;
    expect(a).toMatchObject({ id: brokerage.id, valueCents: brokerage.balanceCents, holdingsOn: "2026-06-30" });
    expect(a.positions.map((p) => p.symbol)).toEqual(["EXTM", "EXIN", "EXBD"]);
    const held = a.positions.reduce((sum, p) => sum + p.marketValueCents, 0);
    expect(a.cashAndOtherCents).toBe(brokerage.balanceCents! - held);

    const withBasis = a.positions.filter((p) => p.costBasisCents !== null);
    expect(s.withBasis).toEqual({
      positions: 2,
      marketValueCents: withBasis.reduce((sum, p) => sum + p.marketValueCents, 0),
      costBasisCents: withBasis.reduce((sum, p) => sum + p.costBasisCents!, 0),
      gainCents: withBasis.reduce((sum, p) => sum + p.gainCents!, 0),
    });
    expect(s.positionsWithoutBasis).toBe(1);

    expect(s.byAccount).toEqual([{ label: brokerage.name, cents: brokerage.balanceCents, share: 1 }]);
    expect(s.byHolding.map((h) => h.label)).toEqual(["EXTM", "EXIN", "EXBD", "Cash and other"]);
    expect(s.byHolding.reduce((sum, h) => sum + h.cents, 0)).toBe(s.totalCents);
    expect(a.series.at(-1)).toMatchObject({ on: "2026-06-30", cents: brokerage.balanceCents, holdingsCents: held });
  });

  it("combines a holding across accounts and lists accounts without positions on their own", async () => {
    const [brokerage] = await db.select().from(accounts).where(eq(accounts.type, "brokerage"));
    // A retirement account holding the same fund, last reported a day earlier.
    const [ira] = await db
      .insert(accounts)
      .values({ name: "Example IRA", institution: "Example Brokerage", type: "retirement", source: "seed", countsTowardBudgets: false, balanceCents: 100_000 })
      .returning();
    await db.insert(holdingSnapshots).values({
      accountId: ira.id,
      on: "2026-06-29",
      externalId: "ira-1",
      symbol: "EXTM",
      description: "Example Total Market Index Fund",
      shares: "1.5",
      marketValueCents: 100_000,
      costBasisCents: 90_000,
      currency: "USD",
    });
    await execute(db, {
      operation: "accounts.createManual",
      input: { name: "Old 401k", kind: "retirement", valueCents: 50_000, on: "2026-06-01" },
      actor: "user",
      reason: "test",
    });

    const s = await investmentsSummary(db, { today });
    expect(s.accounts.find((a) => a.id === ira.id)).toMatchObject({ holdingsOn: "2026-06-29", cashAndOtherCents: 0 });
    const extm = s.byHolding.find((h) => h.label === "EXTM")!;
    const brokerageExtm = s.accounts.find((a) => a.id === brokerage.id)!.positions.find((p) => p.symbol === "EXTM")!;
    expect(extm.cents).toBe(brokerageExtm.marketValueCents + 100_000);
    expect(s.byHolding.find((h) => h.label === "Old 401k (positions not reported)")?.cents).toBe(50_000);
    expect(s.byHolding.reduce((sum, h) => sum + h.cents, 0)).toBe(s.totalCents);
    expect(s.withBasis.positions).toBe(3);
  });
});
