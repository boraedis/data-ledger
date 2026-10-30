import { and, eq, gte, like, lte } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetTargets, categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { lastOfMonth, monthIndex } from "@/lib/budgets/engine";
import { suggestedTargetCents } from "@/lib/budgets/format";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// On the synthetic seed. Groceries (QUILLFIELD MARKET) and coffee (CORNER
// BEAN CAFE) are categorized directly as test setup.

let db: Db;
let cat: Record<string, string>;

type Target = { categoryId: string | null; name: string; start: string; end: string; targetCents: number; spentCents: number; availableCents: number; carryInCents: number };
type Status = { targets: Target[]; unbudgeted: { byCategory: { categoryId: string; name: string; spentCents: number }[] } };

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;
const status = async (on: string) => (await run("budgets.status", { on })).output as Status;
const target = (s: Status, categoryId: string | null) => s.targets.find((t) => t.categoryId === categoryId)!;

async function spentOn(pattern: string, from: string, to: string) {
  const rows = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(like(transactions.description, pattern), gte(transactions.postedOn, from), lte(transactions.postedOn, to)));
  return -rows.reduce((s, r) => s + r.amountCents, 0);
}

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  await db.update(transactions).set({ categoryId: cat.Groceries }).where(like(transactions.description, "QUILLFIELD%"));
  await db.update(transactions).set({ categoryId: cat.Coffee }).where(like(transactions.description, "CORNER BEAN%"));
  await db.update(transactions).set({ categoryId: cat.Paycheck }).where(like(transactions.description, "ACME WIDGETS%"));
});

describe("budgets", () => {
  it("measures a monthly target against net spend in budget accounts, with the rest in the buffer", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 60_000, today: "2026-06-15" });
    await run("budgets.setTarget", { categoryId: null, amountCents: 40_000, today: "2026-06-15" });
    const s = await status("2026-06-20");
    expect(target(s, cat.Groceries)).toMatchObject({ start: "2026-06-01", end: "2026-06-30", targetCents: 60_000, spentCents: await spentOn("QUILLFIELD%", "2026-06-01", "2026-06-20") });
    // Coffee has no target: it draws from the buffer. The paycheck is income, never spend.
    const coffee = await spentOn("CORNER BEAN%", "2026-06-01", "2026-06-20");
    expect(target(s, null)).toMatchObject({ name: "Everything else (buffer)", spentCents: coffee });
    expect(s.unbudgeted.byCategory).toEqual([{ categoryId: cat.Coffee, name: "Coffee", spentCents: coffee }]);
    expect(s.targets[0].categoryId).toBeNull();
  });

  it("versions a change from the current period, corrects within it, and never rewrites history", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 60_000, today: "2026-04-10" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 70_000, today: "2026-06-03" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 75_000, today: "2026-06-20" }); // same period: a correction
    const rows = await db.select().from(budgetTargets).orderBy(budgetTargets.effectiveFrom);
    expect(rows.map((r) => [r.effectiveFrom, r.amountCents])).toEqual([
      ["2026-04-01", 60_000],
      ["2026-06-01", 75_000],
    ]);
    expect(target(await status("2026-05-15"), cat.Groceries).targetCents).toBe(60_000);
    expect(target(await status("2026-06-15"), cat.Groceries).targetCents).toBe(75_000);
  });

  it("gives a new annual target year-to-date progress", async () => {
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 150_000, periodMonths: 12, sinkingFund: true, today: "2026-06-15" });
    const t = target(await status("2026-06-15"), cat.Coffee) as Target & { setAsideMonthlyCents: number; paceCents: number };
    expect(t).toMatchObject({ start: "2026-01-01", end: "2026-12-31", setAsideMonthlyCents: 12_500 });
    expect(t.spentCents).toBe(await spentOn("CORNER BEAN%", "2026-01-01", "2026-06-15"));
    expect(t.paceCents).toBeGreaterThan(0);
  });

  it("removing a target sends its spending to the buffer from this period on", async () => {
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 10_000, today: "2026-05-02" });
    await run("budgets.setTarget", { categoryId: null, amountCents: 50_000, today: "2026-05-02" });
    await run("budgets.removeTarget", { categoryId: cat.Coffee, today: "2026-06-10" });
    expect(target(await status("2026-05-20"), cat.Coffee)).toBeDefined();
    const june = await status("2026-06-20");
    expect(target(june, cat.Coffee)).toBeUndefined();
    // Groceries has no target here either, so both draw from the buffer.
    expect(target(june, null).spentCents).toBe(
      (await spentOn("CORNER BEAN%", "2026-06-01", "2026-06-20")) + (await spentOn("QUILLFIELD%", "2026-06-01", "2026-06-20")),
    );
    await expect(run("budgets.removeTarget", { categoryId: cat.Coffee, today: "2026-06-10" })).rejects.toThrow(/no target/);
  });

  it("rebalances within the period only, as one undoable command", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 60_000, today: "2026-05-02" });
    await run("budgets.setTarget", { categoryId: null, amountCents: 40_000, today: "2026-05-02" });
    const { commandId } = await run("budgets.rebalance", { fromCategoryId: null, toCategoryId: cat.Groceries, amountCents: 5_000, on: "2026-06-10" });
    let june = await status("2026-06-20");
    expect(target(june, cat.Groceries).availableCents).toBe(65_000);
    expect(target(june, null).availableCents).toBe(35_000);
    expect(target(await status("2026-05-20"), cat.Groceries).availableCents).toBe(60_000);

    await undoCommand(db, commandId);
    june = await status("2026-06-20");
    expect(target(june, cat.Groceries).availableCents).toBe(60_000);
    await expect(run("budgets.rebalance", { fromCategoryId: cat.Coffee, toCategoryId: cat.Groceries, amountCents: 1, on: "2026-06-10" })).rejects.toThrow(/no target/);
  });

  it("refuses targets on income categories, and protects categories with budget history", async () => {
    await expect(run("budgets.setTarget", { categoryId: cat.Paycheck, amountCents: 1 })).rejects.toThrow(/expense/);
    await run("budgets.setTarget", { categoryId: cat.Fitness, amountCents: 5_000, today: "2026-06-01" });
    await expect(run("categories.delete", { categoryId: cat.Fitness })).rejects.toThrow(/budget history/);
  });

  it("logs Tally's target changes as proposals", async () => {
    const result = await execute(db, { operation: "budgets.setTarget", input: { categoryId: cat.Coffee, amountCents: 1_000 }, actor: "tally", reason: "suggested" });
    expect(result.status).toBe("proposed");
    expect(await db.select().from(budgetTargets)).toHaveLength(0);
    expect((await db.select().from(commandLog).where(eq(commandLog.actor, "tally")))[0].status).toBe("proposed");
  });
});

describe("budgets.history (#105)", () => {
  type History = { categoryId: string | null; averageCents: number | null; months: { month: string; spentCents: number }[]; overMonths: number | null; comparedMonths: number }[];
  const history = async (on: string) => (await run("budgets.history", { on })).output as History;

  it("averages the three full months before this one from the same lines budgets count, and shows no history for an unused category", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-03-01" });
    const h = await history("2026-06-15");
    const groceries = h.find((r) => r.categoryId === cat.Groceries)!;
    expect(groceries.months.map((m) => m.month)).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    // Each month is what budgets.status counted for it.
    for (const m of groceries.months) {
      const s = await status(lastOfMonth(monthIndex(m.month)));
      expect(m.spentCents).toBe(target(s, cat.Groceries).spentCents);
    }
    const sum = groceries.months.reduce((s, m) => s + m.spentCents, 0);
    expect(groceries.averageCents).toBe(Math.round(sum / 3));
    expect(groceries.comparedMonths).toBe(3);
    expect(groceries.overMonths).toBe(groceries.months.filter((m) => m.spentCents > 30_000).length);
    // June, the current month, isn't in it.
    expect(groceries.months.some((m) => m.month === "2026-06-01")).toBe(false);
    expect(h.find((r) => r.categoryId === cat.Car)).toMatchObject({ averageCents: null, months: [] });
  });

  it("suggests a target only with two months of history, writes nothing for it, and saves it as the owner (#106)", async () => {
    // One May purchase is all Car has: a single month, so no suggestion.
    const [may] = await db.select().from(transactions).where(and(like(transactions.description, "QUILLFIELD%"), gte(transactions.postedOn, "2026-05-01"), lte(transactions.postedOn, "2026-05-31"))).limit(1);
    await db.update(transactions).set({ categoryId: cat.Car }).where(eq(transactions.id, may.id));
    const h = await history("2026-06-15");
    expect(h.find((r) => r.categoryId === cat.Car)!.months).toHaveLength(1);
    expect(suggestedTargetCents(h.find((r) => r.categoryId === cat.Car), 1)).toBeNull();

    const suggestion = suggestedTargetCents(h.find((r) => r.categoryId === cat.Groceries), 1)!;
    expect(suggestion % 100).toBe(0);
    // Reading history and working out a suggestion wrote nothing.
    expect(await db.select().from(budgetTargets)).toHaveLength(0);
    expect(await db.select().from(commandLog).where(eq(commandLog.operation, "budgets.setTarget"))).toHaveLength(0);

    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: suggestion, today: "2026-06-15" });
    expect(await db.select().from(budgetTargets)).toMatchObject([{ categoryId: cat.Groceries, amountCents: suggestion }]);
    expect(await db.select().from(commandLog).where(eq(commandLog.operation, "budgets.setTarget"))).toMatchObject([{ actor: "user", status: "applied" }]);
  });
});
