import { eq, like } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { budgetTargets, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { cloneDb, testDb } from "@/lib/test-utils/db";
import { execute, read, undoCommand } from "@/operations/runtime";
import { endTargetPreview, listTargets } from "@/operations/budgets";

// Ending a budget target on a month (#204), on the synthetic seed. The
// seed's coffee shop (CORNER BEAN CAFE) is filed under Dining as setup.

let db: Db;
let seeded: Db;
let cat: Record<string, string>;

type Target = { categoryId: string | null; targetCents: number; spentCents: number };
type Status = { targets: Target[]; unbudgeted: { byCategory: { categoryId: string; spentCents: number }[] } };

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;
const status = async (on: string) => (await run("budgets.status", { on })).output as Status;
const dining = async (on: string) => (await status(on)).targets.find((t) => t.categoryId === cat.Dining);
const versions = async (categoryId: string) =>
  (await db.select().from(budgetTargets).where(eq(budgetTargets.categoryId, categoryId)).orderBy(budgetTargets.effectiveFrom)).map((v) => [
    v.effectiveFrom,
    v.amountCents,
  ]);

beforeAll(async () => {
  seeded = await testDb();
  await applySeed(seeded, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await seeded.select().from(categories)).map((c) => [c.name, c.id]));
  await seeded.update(transactions).set({ categoryId: cat.Dining }).where(like(transactions.description, "CORNER BEAN%"));
});

beforeEach(async () => {
  db = await cloneDb(seeded);
  // $200/month Dining from January, set in June.
  await run("budgets.backdateTarget", { categoryId: cat.Dining, fromMonth: "2026-01", amountCents: 20_000, today: "2026-06-15" });
});

describe("budgets.endTarget (#204)", () => {
  it("ends a $200 Dining target at March: January and February keep it, and from March its spending falls to the buffer", async () => {
    await run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-03", today: "2026-06-15" });
    expect((await dining("2026-01-20"))?.targetCents).toBe(20_000);
    expect((await dining("2026-02-20"))?.targetCents).toBe(20_000);
    for (const on of ["2026-03-20", "2026-06-20"]) {
      expect(await dining(on), on).toBeUndefined();
      const spent = (await status(on)).unbudgeted.byCategory.find((c) => c.categoryId === cat.Dining);
      expect(spent?.spentCents, on).toBeGreaterThan(0);
    }
    expect(await versions(cat.Dining)).toEqual([
      ["2026-01-01", 20_000],
      ["2026-03-01", null],
    ]);
  });

  it("reviews a past end month by month first, and writes nothing doing it", async () => {
    const preview = await read(db, endTargetPreview, { categoryId: cat.Dining, endMonth: "2026-03", today: "2026-06-15" });
    expect(preview.months.map((m) => [m.month, m.before?.targetCents ?? null, m.after])).toEqual([
      ["2026-03", 20_000, null],
      ["2026-04", 20_000, null],
      ["2026-05", 20_000, null],
      ["2026-06", 20_000, null],
    ]);
    expect(preview.until).toBeNull();
    expect(await versions(cat.Dining)).toEqual([["2026-01-01", 20_000]]);
  });

  it("ends from the current month, or a future one, which changes no month so far", async () => {
    expect((await read(db, endTargetPreview, { categoryId: cat.Dining, endMonth: "2026-08", today: "2026-06-15" })).months).toEqual([]);
    await run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-08", today: "2026-06-15" });
    expect((await dining("2026-06-20"))?.targetCents).toBe(20_000);
    expect(await versions(cat.Dining)).toEqual([
      ["2026-01-01", 20_000],
      ["2026-08-01", null],
    ]);
  });

  it("changes no other target's versions, and a later version still starts as it was", async () => {
    await run("budgets.backdateTarget", { categoryId: cat.Groceries, fromMonth: "2026-02", amountCents: 60_000, today: "2026-06-15" });
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 25_000, today: "2026-06-15" });
    const groceries = await versions(cat.Groceries);
    await run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-03", today: "2026-06-15" });
    expect(await versions(cat.Groceries)).toEqual(groceries);
    expect(await versions(cat.Dining)).toEqual([
      ["2026-01-01", 20_000],
      ["2026-03-01", null],
      ["2026-06-01", 25_000],
    ]);
    expect((await dining("2026-04-20"))).toBeUndefined();
    expect((await dining("2026-06-20"))?.targetCents).toBe(25_000);
  });

  it("lets a new target start normally after the end, and keeps the history listed", async () => {
    await run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-03", today: "2026-04-10" });
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 15_000, today: "2026-06-15" });
    expect((await dining("2026-06-20"))?.targetCents).toBe(15_000);
    expect(await dining("2026-04-20")).toBeUndefined();
    const history = (await read(db, listTargets, {})).filter((v) => v.categoryId === cat.Dining).map((v) => [v.effectiveFrom, v.amountCents]);
    expect(history).toEqual([
      ["2026-01-01", 20_000],
      ["2026-03-01", null],
      ["2026-06-01", 15_000],
    ]);
  });

  it("refuses an end with no target in effect, at a version's own start, or inside an annual period", async () => {
    await expect(run("budgets.endTarget", { categoryId: cat.Groceries, endMonth: "2026-03", today: "2026-06-15" })).rejects.toThrow(/no target/);
    await expect(run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-01", today: "2026-06-15" })).rejects.toThrow(/delete that version/);
    await run("budgets.backdateTarget", { categoryId: cat.Coffee, fromMonth: "2026-01", amountCents: 120_000, periodMonths: 12, today: "2026-06-15" });
    await expect(run("budgets.endTarget", { categoryId: cat.Coffee, endMonth: "2026-05", today: "2026-06-15" })).rejects.toThrow(/one budget/);
  });

  it("can be undone", async () => {
    const { commandId } = await run("budgets.endTarget", { categoryId: cat.Dining, endMonth: "2026-03", today: "2026-06-15" });
    await undoCommand(db, commandId, { actor: "user", reason: "test" });
    expect(await versions(cat.Dining)).toEqual([["2026-01-01", 20_000]]);
  });
});
