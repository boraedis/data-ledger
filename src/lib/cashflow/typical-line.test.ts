import { beforeEach, describe, expect, it } from "vitest";
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

  it("is none for pay periods, and gives Annual only the months three complete months back", async () => {
    expect(await typicalLine(db, periodFor("pay", "2026"), "2026-06-30", false)).toBeNull();
    const line = await typicalLine(db, periodFor("annual", "2026"), "2026-06-30", false);
    if (line) {
      expect(line.slots).toHaveLength(12);
      // Nothing past the month in progress: July's three before include June, which isn't over.
      expect(line.slots.slice(6).every((s) => s === null)).toBe(true);
    }
  });
});
