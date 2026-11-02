import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { cloneDb, testDb } from "@/lib/test-utils/db";
import { itemAnalysis, rangeMonths } from "@/operations/budgets";
import { execute, read } from "@/operations/runtime";

// A budget item over time (#206), on the synthetic seed. A $200/month
// Dining target, with one invented charge a month from July 2025 to June
// 2026, between $150 and $260.

const SPEND: [string, number][] = [
  ["2025-07", 150], ["2025-08", 180], ["2025-09", 200], ["2025-10", 210], ["2025-11", 260], ["2025-12", 190],
  ["2026-01", 170], ["2026-02", 230], ["2026-03", 160], ["2026-04", 250], ["2026-05", 200], ["2026-06", 220],
];
const ON = "2026-06-30";

let db: Db;
let seeded: Db;
let dining: string;

beforeAll(async () => {
  seeded = await testDb();
  await applySeed(seeded, { endDate: new Date(ON) });
  [{ id: dining }] = await seeded.select({ id: categories.id }).from(categories).where(eq(categories.name, "Dining"));
  const [{ id: card }] = await seeded.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  await seeded.insert(transactions).values(
    SPEND.map(([month, dollars], i) => ({
      accountId: card,
      postedOn: `${month}-15`,
      amountCents: -dollars * 100,
      description: `SALTMARSH BISTRO ${i}`,
      merchant: "Saltmarsh Bistro",
      categoryId: dining,
      externalId: `dining-${month}`,
    })),
  );
  await execute(seeded, {
    operation: "budgets.backdateTarget",
    input: { categoryId: dining, fromMonth: "2025-07", amountCents: 20_000, today: ON },
    actor: "user",
    reason: "test",
  });
});

beforeEach(async () => {
  db = await cloneDb(seeded);
});

describe("budgets.itemAnalysis (#206)", () => {
  it("shows 12 months against the $200 line, the average, the typical month and the months over target", async () => {
    const a = await read(db, itemAnalysis, { categoryId: dining, on: ON });
    expect(a.range).toBe("12");
    expect(a.months.map((m) => [m.month.slice(0, 7), m.spentCents, m.targetCents])).toEqual(SPEND.map(([month, d]) => [month, d * 100, 20_000]));
    // Over the 11 complete months (June is in progress).
    expect(a.completeMonths).toBe(11);
    expect(a.averageCents).toBe(20_000);
    expect(a.typicalCents).toBe(20_000);
    // Over: October, November, February, April, and June, already over at $220.
    expect(a.overMonths).toBe(5);
    expect(a.underMonths).toBe(7);
  });

  it("lists the range's largest charges, biggest first", async () => {
    const a = await read(db, itemAnalysis, { categoryId: dining, on: ON });
    expect(a.largest.map((l) => l.spentCents)).toEqual([26_000, 25_000, 23_000, 22_000, 21_000]);
    expect(a.largest[0]).toMatchObject({ merchant: "Saltmarsh Bistro", date: "2025-11-15", accountName: "Rewards Card", categoryName: "Dining" });
  });

  it("gives the year so far as the year counts it: spent of the year's budget", async () => {
    const a = await read(db, itemAnalysis, { categoryId: dining, on: ON });
    expect(a.yearToDate).toEqual({ year: 2026, targetCents: 240_000, spentCents: 123_000, remainingCents: 117_000 });
  });

  it("updates every figure for 3 months and the year to date", async () => {
    const three = await read(db, itemAnalysis, { categoryId: dining, on: ON, range: "3" });
    expect(three.months.map((m) => m.month.slice(0, 7))).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect([three.completeMonths, three.averageCents, three.overMonths, three.underMonths]).toEqual([2, 22_500, 2, 1]);
    expect(three.largest.map((l) => l.spentCents)).toEqual([25_000, 22_000, 20_000]);

    const ytd = await read(db, itemAnalysis, { categoryId: dining, on: ON, range: "ytd" });
    expect(ytd.months).toHaveLength(6);
    expect(ytd.from).toBe("2026-01-01");
    expect([ytd.completeMonths, ytd.averageCents, ytd.typicalCents, ytd.overMonths]).toEqual([5, 20_200, 20_000, 3]);
  });

  it("works out a range's months through the month of `on`", () => {
    expect([rangeMonths("3", ON), rangeMonths("12", ON), rangeMonths("ytd", ON), rangeMonths("ytd", "2026-01-04")]).toEqual([3, 12, 6, 1]);
  });
});
