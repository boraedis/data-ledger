import { and, eq, gte, like, lte } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, budgetTargets, categories, commandLog, payStubLines, payStubs, transactions } from "@/db/schema";
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

describe("budgets.monthly (#107)", () => {
  type Monthly = { categoryId: string | null; months: { month: string; spentCents: number; targetCents: number | null }[] }[];
  const monthly = async (on: string) => (await run("budgets.monthly", { on })).output as Monthly;

  it("lists six months; where the target was in effect each matches budgets.status, and before it, what it would cover", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-03-10" });
    await run("budgets.setTarget", { categoryId: cat.Car, amountCents: 5_000, today: "2026-03-10" });
    const series = await monthly("2026-06-15");
    const groceries = series.find((s) => s.categoryId === cat.Groceries)!.months;
    expect(groceries.map((m) => m.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(groceries.map((m) => m.targetCents)).toEqual([null, null, 30_000, 30_000, 30_000, 30_000]);
    for (const m of groceries.slice(2)) {
      // June is as of the 15th, as the card shows it.
      const on = m.month === "2026-06-01" ? "2026-06-15" : lastOfMonth(monthIndex(m.month));
      expect(m.spentCents).toBe(target(await status(on), cat.Groceries).spentCents);
    }
    // Before the target, the category's own spending.
    expect(groceries[0].spentCents).toBe(await spentOn("QUILLFIELD%", "2026-01-01", "2026-01-31"));
    expect(groceries[0].spentCents).toBeGreaterThan(0);
    // Nothing spent is a $0 month, not a missing one.
    expect(series.find((s) => s.categoryId === cat.Car)!.months.map((m) => m.spentCents)).toEqual([0, 0, 0, 0, 0, 0]);
    // The buffer has no target, so no series.
    expect(series.some((s) => s.categoryId === null)).toBe(false);
  });

  it("gives a multi-month target its monthly share, with its months adding up to the period's spend", async () => {
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 120_000, periodMonths: 12, today: "2026-03-10" });
    const coffee = (await monthly("2026-06-15")).find((s) => s.categoryId === cat.Coffee)!.months;
    expect(coffee.every((m) => m.targetCents === 10_000)).toBe(true);
    const sum = coffee.reduce((s, m) => s + m.spentCents, 0);
    expect(sum).toBe(target(await status("2026-06-15"), cat.Coffee).spentCents);
  });
});

describe("budgets.monthly over a year (#108)", () => {
  type Monthly = { categoryId: string | null; months: { month: string; spentCents: number; targetCents: number | null }[] }[];
  const grid = async (on: string) => (await run("budgets.monthly", { on, months: 12, includeEnded: true })).output as Monthly;

  it("gives each month the target version it had, matching budgets.status, and keeps a target ended since", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-01-10" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 45_000, today: "2026-04-10" });
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 6_000, today: "2026-02-10" });
    await run("budgets.removeTarget", { categoryId: cat.Coffee, today: "2026-05-10" });

    const rows = await grid("2026-06-30");
    const groceries = rows.find((r) => r.categoryId === cat.Groceries)!.months;
    expect(groceries).toHaveLength(12);
    expect(groceries[0].month).toBe("2025-07-01");
    expect(groceries.slice(6).map((m) => m.targetCents)).toEqual([30_000, 30_000, 30_000, 45_000, 45_000, 45_000]);
    for (const m of groceries.slice(6)) {
      expect(m.spentCents).toBe(target(await status(lastOfMonth(monthIndex(m.month))), cat.Groceries).spentCents);
    }

    // Ended in May: still a row, with the target it had in Feb–Apr only.
    const coffee = rows.find((r) => r.categoryId === cat.Coffee)!.months;
    expect(coffee.slice(6).map((m) => m.targetCents)).toEqual([null, 6_000, 6_000, 6_000, null, null]);
    for (const m of coffee.slice(7, 10)) {
      expect(m.spentCents).toBe(target(await status(lastOfMonth(monthIndex(m.month))), cat.Coffee).spentCents);
    }
    // Without includeEnded (the cards), only targets in effect now.
    const cards = (await run("budgets.monthly", { on: "2026-06-30" })).output as Monthly;
    expect(cards.some((r) => r.categoryId === cat.Coffee)).toBe(false);
  });
});

describe("budgets.yearlyCharges (#109)", () => {
  type Yearly = { categoryId: string; amountCents: number; setAsideMonthlyCents: number; anchorMonth: string; charges: { merchant: string }[] }[];
  const yearly = async () => (await run("budgets.yearlyCharges", { on: "2026-06-30" })).output as Yearly;

  it("suggests a set-aside only for a charge found yearly, writes nothing, and accepting makes a sinking-fund target", async () => {
    const [{ id: cardId }] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
    // The seed's yearly plan is charged once in its window: not a pattern yet.
    expect(await yearly()).toEqual([]);

    // A made-up premium, a year apart, filed under Car.
    for (const [postedOn, externalId] of [["2025-03-14", "premium-1"], ["2026-03-12", "premium-2"]]) {
      await db.insert(transactions).values({
        accountId: cardId, postedOn, amountCents: -60_000, description: "PINEWAY AUTO INSURANCE", merchant: "Pineway Auto Insurance", externalId, categoryId: cat.Car,
      });
    }
    const [suggestion] = await yearly();
    expect(suggestion).toMatchObject({ categoryId: cat.Car, amountCents: 60_000, setAsideMonthlyCents: 5_000, anchorMonth: "2026-04", charges: [{ merchant: "Pineway Auto Insurance" }] });
    expect(await db.select().from(budgetTargets)).toHaveLength(0);

    // Accepting is the ordinary target save, as the owner.
    await run("budgets.setTarget", { categoryId: cat.Car, amountCents: suggestion.amountCents, periodMonths: 12, anchorMonth: suggestion.anchorMonth, sinkingFund: true, today: "2026-06-30" });
    expect(target(await status("2026-06-30"), cat.Car)).toMatchObject({ start: "2026-04-01", end: "2027-03-31", targetCents: 60_000, setAsideMonthlyCents: 5_000 });
    expect(await db.select().from(commandLog).where(eq(commandLog.operation, "budgets.setTarget"))).toMatchObject([{ actor: "user" }]);
  });

  it("leaves out a yearly charge the owner dismissed on Subscriptions", async () => {
    const [{ id: cardId }] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
    for (const [postedOn, externalId] of [["2025-03-14", "premium-1"], ["2026-03-12", "premium-2"]]) {
      await db.insert(transactions).values({
        accountId: cardId, postedOn, amountCents: -60_000, description: "PINEWAY AUTO INSURANCE", merchant: "Pineway Auto Insurance", externalId, categoryId: cat.Car,
      });
    }
    await run("recurring.setStatus", { merchant: "Pineway Auto Insurance", accountId: cardId, status: "dismissed" });
    expect(await yearly()).toEqual([]);
  });
});

describe("what the buffer covers (#110)", () => {
  type Covers = { unbudgeted: { start: string; end: string; covers: { categoryId: string; name: string; spentCents: number }[] } };

  it("lists every category without a target of its own or its parent's, $0 included, adding up to the buffer's spend", async () => {
    // A made-up subcategory under Groceries, to show a parent's target covers it.
    const [bulk] = await db.insert(categories).values({ name: "Bulk Store", parentId: cat.Groceries, kind: "expense" }).returning();
    await run("budgets.setTarget", { categoryId: null, amountCents: 100_000, today: "2026-06-01" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-06-01" });

    const s = (await run("budgets.status", { on: "2026-06-30" })).output as Status & Covers;
    const covers = s.unbudgeted.covers;
    const ids = covers.map((c) => c.categoryId);
    expect(ids).not.toContain(cat.Groceries);
    expect(ids).not.toContain(bulk.id);
    expect(ids).toContain(cat.Coffee);
    // Car has nothing this month and is still listed.
    expect(covers.find((c) => c.categoryId === cat.Car)).toMatchObject({ spentCents: 0 });
    // Income and transfers aren't the buffer's.
    expect(ids).not.toContain(cat.Paycheck);
    expect(covers.reduce((sum, c) => sum + c.spentCents, 0)).toBe(target(s, null).spentCents);
    expect(target(s, null).spentCents).toBeGreaterThan(0);
  });
});

describe("budgets.year (#123)", () => {
  type Year = {
    targets: { categoryId: string | null; targetCents: number; spentCents: number; remainingCents: number; periods: number }[];
    total: { targetCents: number; spentCents: number; remainingCents: number };
  };
  const year = async (y: number) => (await run("budgets.year", { year: y })).output as Year;

  it("counts each period at the version it had, keeps an ended target's periods, and totals the targets", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-01-10" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 45_000, today: "2026-04-10" });
    await run("budgets.removeTarget", { categoryId: cat.Groceries, today: "2026-07-10" });
    await run("budgets.setTarget", { categoryId: null, amountCents: 100_000, today: "2026-03-10" });

    const y = await year(2026);
    const groceries = y.targets.find((t) => t.categoryId === cat.Groceries)!;
    expect(groceries).toMatchObject({ periods: 6, targetCents: 3 * 30_000 + 3 * 45_000 });
    // Each period's spending is what budgets.status counted for it.
    let spent = 0;
    for (let m = 1; m <= 6; m++) spent += target(await status(lastOfMonth(monthIndex(`2026-0${m}-01`))), cat.Groceries).spentCents;
    expect(groceries.spentCents).toBe(spent);
    expect(groceries.remainingCents).toBe(groceries.targetCents - groceries.spentCents);

    // The buffer runs March to December: ten months of target, spending so far.
    expect(y.targets.find((t) => t.categoryId === null)).toMatchObject({ periods: 10, targetCents: 10 * 100_000 });
    const sum = (pick: (t: Year["targets"][number]) => number) => y.targets.reduce((s, t) => s + pick(t), 0);
    expect(y.total).toEqual({ targetCents: sum((t) => t.targetCents), spentCents: sum((t) => t.spentCents), remainingCents: sum((t) => t.remainingCents) });
  });

  it("splits a period across two years by its months in each", async () => {
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 120_000, periodMonths: 12, anchorMonth: "2026-04", today: "2026-05-10" });
    const coffee = (await year(2026)).targets.find((t) => t.categoryId === cat.Coffee)!;
    // April 2026 to March 2027: nine of its months are 2026's.
    expect(coffee).toMatchObject({ periods: 1, targetCents: 90_000 });
    expect(coffee.spentCents).toBe(target(await status("2026-06-30"), cat.Coffee).spentCents);
    // 2027 has the last three months of that period and nine of the next.
    expect((await year(2027)).targets.find((t) => t.categoryId === cat.Coffee)).toMatchObject({ periods: 2, targetCents: 30_000 + 90_000, spentCents: 0 });
  });
});

describe("budgets.backdateTarget (#130)", () => {
  const backdate = (input: Record<string, unknown>) => run("budgets.backdateTarget", { today: "2026-06-15", ...input });

  it("fills March to May before a June version, which keeps its amount, and leaves earlier months alone", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 35_000, today: "2026-06-10" });
    const result = await backdate({ categoryId: cat.Dining, fromMonth: "2026-03", amountCents: 40_000 });
    expect(result.output).toMatchObject({ effectiveFrom: "2026-03-01", until: "2026-06-01" });

    for (const on of ["2026-03-31", "2026-04-30", "2026-05-31"]) expect(target(await status(on), cat.Dining).targetCents).toBe(40_000);
    expect(target(await status("2026-06-30"), cat.Dining).targetCents).toBe(35_000);
    // February had no target and still has none: spending only.
    expect((await status("2026-02-28")).targets.some((t) => t.categoryId === cat.Dining)).toBe(false);

    // The log keeps the chosen start month.
    const [logged] = await db.select().from(commandLog).where(eq(commandLog.operation, "budgets.backdateTarget"));
    expect(logged).toMatchObject({ actor: "user", input: expect.objectContaining({ fromMonth: "2026-03" }) });
  });

  it("only fills months with no target, never before the first transactions, and not this month", async () => {
    await backdate({ categoryId: cat.Dining, fromMonth: "2026-03", amountCents: 40_000 });
    await expect(backdate({ categoryId: cat.Dining, fromMonth: "2026-04", amountCents: 1_000 })).rejects.toThrow(/already in effect/);
    await expect(backdate({ categoryId: cat.Coffee, fromMonth: "2015-01", amountCents: 1_000 })).rejects.toThrow(/earliest a target can start/);
    await expect(backdate({ categoryId: cat.Coffee, fromMonth: "2026-06", amountCents: 1_000 })).rejects.toThrow(/this month or later/);
  });

  it("backdates the buffer too, and a new target with nothing after it runs on to today", async () => {
    const result = await backdate({ categoryId: null, fromMonth: "2026-02", amountCents: 100_000 });
    expect(result.output).toMatchObject({ until: null });
    expect(target(await status("2026-02-28"), null).targetCents).toBe(100_000);
    expect(target(await status("2026-06-15"), null).targetCents).toBe(100_000);
  });
});

describe("budgets.pay (#128)", () => {
  type Pay = {
    pay: { recordedCents: number; recordedCount: number; netPayCents: number | null };
    typical: { cents: number } | null;
    landedDifferenceCents: number | null;
    summary: { expectedSaving: { cents: number; percent: number | null }; actualSaving: { cents: number } } | null;
    targetsCents: number;
    spentCents: number;
  };
  const pay = async (on: string) => (await run("budgets.pay", { on, today: "2026-06-30" })).output as Pay;

  it("sets the month's pay stubs against targets at their monthly share and spending so far", async () => {
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-06-01" });
    await run("budgets.setTarget", { categoryId: cat.Coffee, amountCents: 120_000, periodMonths: 12, today: "2026-06-01" });
    const p = await pay("2026-06-30");
    const stubs = (await db.select().from(payStubs)).filter((s) => s.payDate.startsWith("2026-06"));
    expect(stubs.length).toBeGreaterThan(0);
    expect(p.pay).toMatchObject({ recordedCount: stubs.length, recordedCents: stubs.reduce((s, x) => s + x.netCents, 0) });
    // Monthly Groceries in full, a twelfth of the annual Coffee target.
    expect(p.targetsCents).toBe(30_000 + 10_000);
    // Measured against a typical month (#142); what landed is reported beside it.
    expect(p.typical!.cents).toBeGreaterThan(0);
    expect(p.summary!.expectedSaving.cents).toBe(p.typical!.cents - p.targetsCents);
    expect(p.summary!.actualSaving.cents).toBe(p.typical!.cents - p.spentCents);
    expect(p.landedDifferenceCents).toBe(p.pay.netPayCents! - p.typical!.cents);
  });

  it("counts a purchase as spending but never a transfer to savings", async () => {
    const [account] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
    const before = (await pay("2026-06-30")).spentCents;
    await db.insert(transactions).values({ accountId: account.id, postedOn: "2026-06-20", amountCents: -4_250, description: "MADE-UP BISTRO", externalId: "pay-test-1", categoryId: cat.Dining });
    await db.insert(transactions).values({ accountId: account.id, postedOn: "2026-06-21", amountCents: -50_000, description: "TO SAVINGS", externalId: "pay-test-2", categoryId: cat.Transfers });
    expect((await pay("2026-06-30")).spentCents).toBe(before + 4_250);
  });

  it("doesn't count a paycheck's deductions as spending, since net pay is already after them", async () => {
    const before = await pay("2026-06-30");
    // File the synthetic stubs' health insurance under an expense category:
    // budgets now count it, as a line on each linked paycheck.
    await db.update(payStubLines).set({ categoryId: cat.Car }).where(eq(payStubLines.kind, "health_insurance"));
    const lines = (await run("transactions.spendingLines", { from: "2026-06-01", to: "2026-06-30" })).output as { categoryId: string }[];
    expect(lines.some((l) => l.categoryId === cat.Car)).toBe(true);
    expect((await pay("2026-06-30")).spentCents).toBe(before.spentCents);
  });

  it("says no pay was recorded for a month before any stubs", async () => {
    expect(await pay("2026-01-31")).toMatchObject({ pay: { netPayCents: null }, typical: null, summary: null });
  });
});

describe("budgets.targetTransactions (#135)", () => {
  type Lines = { spentCents: number; totalCents: number; lines: { transactionId: string; amountCents: number; categoryName: string }[] } | null;
  const lines = async (categoryId: string | null, on: string, gross = false) =>
    (await run("budgets.targetTransactions", { categoryId, on, gross })).output as Lines;
  let cardId: string;
  const purchase = async (postedOn: string, amountCents: number, categoryId: string, externalId: string) =>
    (await db.insert(transactions).values({ accountId: cardId, postedOn, amountCents, description: `MADE-UP ${externalId}`, externalId, categoryId }).returning())[0];

  beforeEach(async () => {
    [{ id: cardId }] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
    // Only these made-up purchases are Dining.
    await db.update(transactions).set({ categoryId: null }).where(eq(transactions.categoryId, cat.Dining));
  });

  it("lists the three purchases behind a $400 Dining target, totalling $312.50 as the card does", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 40_000, today: "2026-05-01" });
    for (const [day, cents, id] of [["2026-05-03", -10_000, "d1"], ["2026-05-12", -11_250, "d2"], ["2026-05-20", -10_000, "d3"]] as const) {
      await purchase(day, cents, cat.Dining, id);
    }
    const l = (await lines(cat.Dining, "2026-05-31"))!;
    expect(l.lines).toHaveLength(3);
    expect(l).toMatchObject({ totalCents: 31_250, spentCents: 31_250 });
    expect(target(await status("2026-05-31"), cat.Dining).spentCents).toBe(31_250);
  });

  it("includes a refund, which lowers the total as on the card", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 40_000, today: "2026-05-01" });
    await purchase("2026-05-03", -10_000, cat.Dining, "d1");
    await purchase("2026-05-09", 2_500, cat.Dining, "refund");
    const l = (await lines(cat.Dining, "2026-05-31"))!;
    expect(l.lines.map((x) => x.amountCents).sort((a, b) => a - b)).toEqual([-10_000, 2_500]);
    expect(l).toMatchObject({ totalCents: 7_500, spentCents: 7_500 });
  });

  it("gives the buffer every category without a target, never transfers or income, matching its card", async () => {
    await run("budgets.setTarget", { categoryId: null, amountCents: 100_000, today: "2026-06-01" });
    await run("budgets.setTarget", { categoryId: cat.Groceries, amountCents: 30_000, today: "2026-06-01" });
    await purchase("2026-06-10", -50_000, cat.Transfers, "to-savings");
    const l = (await lines(null, "2026-06-30"))!;
    expect(l.totalCents).toBe(target(await status("2026-06-30"), null).spentCents);
    expect(l.totalCents).toBeGreaterThan(0);
    const names = new Set(l.lines.map((x) => x.categoryName));
    for (const excluded of ["Groceries", "Transfers", "Paycheck"]) expect(names.has(excluded)).toBe(false);
  });

  it("in the gross view, doesn't net off what friends owe", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 40_000, today: "2026-05-01" });
    const dinner = await purchase("2026-05-15", -12_000, cat.Dining, "shared");
    // A made-up friend owes half of it.
    const alex = (await run("people.create", { name: "Alex" })).output as { id: string };
    await run("reimbursements.setShares", { transactionId: dinner.id, shares: [{ personId: alex.id, amountCents: 6_000 }] });
    expect((await lines(cat.Dining, "2026-05-31"))!.totalCents).toBe(6_000);
    expect((await lines(cat.Dining, "2026-05-31", true))!.totalCents).toBe(12_000);
  });
});

describe("budgets.backdatePreview (#137)", () => {
  type Preview = { months: { month: string; before: { targetCents: number } | null; after: { targetCents: number } | null }[]; until: string | null };
  const preview = async (input: Record<string, unknown>) => (await run("budgets.backdatePreview", { today: "2026-06-15", ...input })).output as Preview;

  it("lists March to May changing from no target to $400, leaves out June's $350, and writes nothing", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 35_000, today: "2026-06-10" });
    const p = await preview({ categoryId: cat.Dining, fromMonth: "2026-03", amountCents: 40_000 });
    expect(p.months).toEqual([
      { month: "2026-03", before: null, after: expect.objectContaining({ targetCents: 40_000 }) },
      { month: "2026-04", before: null, after: expect.objectContaining({ targetCents: 40_000 }) },
      { month: "2026-05", before: null, after: expect.objectContaining({ targetCents: 40_000 }) },
    ]);
    expect(p.until).toBe("2026-06-01");
    expect(await db.select().from(budgetTargets).where(eq(budgetTargets.effectiveFrom, "2026-03-01"))).toEqual([]);
  });

  it("matches what the page shows for those months once saved", async () => {
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 35_000, today: "2026-06-10" });
    const input = { categoryId: cat.Dining, fromMonth: "2026-02", amountCents: 120_000, periodMonths: 3, anchorMonth: "2026-02" };
    const p = await preview(input);
    await run("budgets.backdateTarget", { today: "2026-06-15", ...input });
    for (const m of p.months) {
      const t = target(await status(lastOfMonth(monthIndex(`${m.month}-01`))), cat.Dining);
      expect(t.targetCents).toBe(m.after!.targetCents);
    }
    // A quarter from February, cut short by June's version: February to April, then May alone.
    expect(p.months.map((m) => m.after!.targetCents)).toEqual([120_000, 120_000, 120_000, 40_000]);
  });

  it("refuses what the save would refuse", async () => {
    await expect(preview({ categoryId: cat.Coffee, fromMonth: "2026-06", amountCents: 1_000 })).rejects.toThrow(/this month or later/);
    await expect(preview({ categoryId: cat.Coffee, fromMonth: "2015-01", amountCents: 1_000 })).rejects.toThrow(/earliest a target can start/);
  });
});

describe("budgets.monthly details for the Year view tooltip (#139)", () => {
  type Month = { month: string; spentCents: number; targetCents: number | null; transactions: number; period?: { carryInCents: number; availableCents: number; rollover: boolean } | null };
  const grid = async (on: string) =>
    (await run("budgets.monthly", { on, months: 12, includeEnded: true, details: true })).output as { categoryId: string | null; months: Month[] }[];

  it("counts March's three Dining purchases, $312.50 against $400, and gives a rollover month its carry-in", async () => {
    const [{ id: cardId }] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
    await db.update(transactions).set({ categoryId: null }).where(eq(transactions.categoryId, cat.Dining));
    await run("budgets.setTarget", { categoryId: cat.Dining, amountCents: 40_000, rollover: true, today: "2026-03-05" });
    for (const [day, cents, id] of [["2026-03-03", -10_000, "m1"], ["2026-03-12", -11_250, "m2"], ["2026-03-20", -10_000, "m3"], ["2026-04-02", -5_000, "a1"]] as const) {
      await db.insert(transactions).values({ accountId: cardId, postedOn: day, amountCents: cents, description: `MADE-UP ${id}`, externalId: id, categoryId: cat.Dining });
    }
    const dining = (await grid("2026-04-30")).find((r) => r.categoryId === cat.Dining)!.months;
    const march = dining.find((m) => m.month === "2026-03-01")!;
    expect(march).toMatchObject({ spentCents: 31_250, targetCents: 40_000, transactions: 3 });
    expect(march.targetCents! - march.spentCents).toBe(8_750);
    // April rolls March's $87.50 in: $487.50 available, as its card says.
    const april = dining.find((m) => m.month === "2026-04-01")!;
    expect(april.period).toMatchObject({ rollover: true, carryInCents: 8_750, availableCents: 48_750 });
    expect(target(await status("2026-04-30"), cat.Dining)).toMatchObject({ carryInCents: 8_750, availableCents: 48_750 });
  });
});
