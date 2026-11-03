import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { firstRecordedDay, typicalLine } from "@/lib/cashflow/data";
import { runCategorization } from "@/lib/categorize/pipeline";
import { periodFor } from "@/lib/cashflow/view";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";

// The typical line on the synthetic seed (which ends 2026-06-30).

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  await runCategorization(db);
});

describe("typicalLine", () => {
  it("starts at the earliest recorded day, and has none on an empty ledger", async () => {
    expect(await firstRecordedDay(db)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await firstRecordedDay(await testDb())).toBeNull();
    expect(await typicalLine(await testDb(), periodFor("monthly", "2026-06"), "2026-06-30", false)).toBeNull();
  });

  it("gives a month its pace from the three months before, one slot per day", async () => {
    // The seed's history begins before 2026-03-01, so Mar, Apr and May are whole and recorded.
    expect((await firstRecordedDay(db))! < "2026-03-01").toBe(true);
    const line = await typicalLine(db, periodFor("monthly", "2026-06"), "2026-06-30", false);
    expect(line?.label).toMatch(/3 months before/);
    expect(line?.slots).toHaveLength(30);
    const slots = line!.slots.map((s) => s!);
    // Running totals only grow, and the seed's May pay lifts the average.
    expect(slots.every((s, i) => i === 0 || (s.inCents >= slots[i - 1].inCents && s.outCents >= slots[i - 1].outCents))).toBe(true);
    expect(slots.at(-1)!.inCents).toBeGreaterThan(0);
  });

  it("is none for a month with fewer than three whole months before it", async () => {
    const first = (await firstRecordedDay(db))!;
    expect(await typicalLine(db, periodFor("monthly", first.slice(0, 7)), "2026-06-30", false)).toBeNull();
  });

  it("is none for pay periods, and for Annual when no earlier year has a whole month", async () => {
    expect(await typicalLine(db, periodFor("pay", "2026"), "2026-06-30", false)).toBeNull();
    // The seed's history begins 2025-12-30: no whole month before 2026.
    expect(await typicalLine(db, periodFor("annual", "2026"), "2026-06-30", false)).toBeNull();
    expect(await typicalLine(db, periodFor("annual", "2026"), "2026-06-30", false, "day")).toBeNull();
  });

  describe("Annual, with earlier years", () => {
    beforeEach(async () => {
      const [{ id: accountId }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "checking"));
      const [{ id: categoryId }] = await db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "income")).limit(1);
      const income = (postedOn: string, amountCents: number) => ({ accountId, categoryId, postedOn, amountCents, description: "Example income", externalId: `typical-${postedOn}` });
      // History begins 2024-01-05: January 2024 is partial, March 2024 and 2025 are whole.
      await db.insert(transactions).values([income("2024-01-05", 100_00), income("2024-03-15", 1_000_00), income("2025-03-15", 2_000_00)]);
    });

    it("by month, averages the same month of the earlier years that have it whole", async () => {
      const line = await typicalLine(db, periodFor("annual", "2026"), "2026-06-30", false);
      expect(line?.unit).toBe("year");
      expect(line?.slots).toHaveLength(12);
      // March: 2025 and 2024 (2023 is before history).
      expect(line?.slots[2]).toMatchObject({ inCents: 1_500_00, periods: 2 });
      // January 2024 began part way through, so only 2025 counts.
      expect(line?.slots[0]).toMatchObject({ inCents: 0, periods: 1 });
    });

    it("by day, uses only whole years, one here", async () => {
      const line = await typicalLine(db, periodFor("annual", "2026"), "2026-06-30", false, "day");
      expect(line?.slots).toHaveLength(365);
      // March 15 is the 74th day: 2025's running total by then is its one payment.
      expect(line?.slots[73]).toEqual({ inCents: 2_000_00, outCents: 0, periods: 1 });
      expect(line?.slots[0]).toMatchObject({ inCents: 0, periods: 1 });
    });
  });
});
