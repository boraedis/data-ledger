import { eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { rollUp, total, type FlowDay } from "@/lib/cashflow/series";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// Cash in and out (#169) on the synthetic seed, which ends in June 2026, so
// a week in January 2030 starts empty and only holds the made-up lines
// each test adds. No real data anywhere.

let db: Db;
let cat: Record<string, string>;
let acct: Record<"checking" | "savings" | "credit", string>;
type Series = { days: FlowDay[]; totals: { inCents: number; outCents: number; netCents: number } };

const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, actor: "user", reason: "Test", input });
const series = async (from: string, to: string) => ((await run("cashflow.series", { from, to })) as { output: Series }).output;
let n = 0;
async function add(account: keyof typeof acct, postedOn: string, amountCents: number, description: string, categoryId: string | null = null) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: acct[account], postedOn, amountCents, description, externalId: `cashflow-test-${n++}`, categoryId })
    .returning();
  return row;
}
async function pair(a: { id: string }, b: { id: string }) {
  await db.update(transactions).set({ transferPairId: b.id }).where(eq(transactions.id, a.id));
  await db.update(transactions).set({ transferPairId: a.id }).where(eq(transactions.id, b.id));
}

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  const rows = await db.select().from(accounts);
  const of = (type: string) => rows.find((r) => r.type === type)!.id;
  acct = { checking: of("checking"), savings: of("savings"), credit: of("credit") };
  await add("checking", "2030-01-09", 300_000, "SYNTHETIC EMPLOYER PAYROLL", cat.Paycheck);
  await add("checking", "2030-01-08", -12_000, "SYNTHETIC GROCER", cat.Groceries);
  await add("credit", "2030-01-12", -8_000, "SYNTHETIC GROCER", cat.Groceries);
});

describe("cashflow.series (#169)", () => {
  it("gives a $3,000 paycheck and $200 of groceries in a week as $3,000 in, $200 out, $2,800 net", async () => {
    expect((await series("2030-01-07", "2030-01-13")).totals).toEqual({ inCents: 300_000, outCents: 20_000, netCents: 280_000 });
  });

  it("leaves a $500 move from checking to savings, and a matched card payment, out of both", async () => {
    await pair(await add("checking", "2030-01-10", -50_000, "TRANSFER TO SAVINGS"), await add("savings", "2030-01-10", 50_000, "TRANSFER FROM CHECKING"));
    await pair(await add("checking", "2030-01-11", -8_000, "SYNTHETIC CARD PAYMENT"), await add("credit", "2030-01-12", 8_000, "PAYMENT THANK YOU"));
    // Filed under a transfer category rather than paired: still neither.
    await add("checking", "2030-01-13", -20_000, "MOVE TO BROKERAGE", cat.Transfers);
    expect((await series("2030-01-07", "2030-01-13")).totals).toEqual({ inCents: 300_000, outCents: 20_000, netCents: 280_000 });
  });

  it("makes the month equal its days and its weeks", async () => {
    await add("checking", "2030-01-23", 300_000, "SYNTHETIC EMPLOYER PAYROLL", cat.Paycheck);
    await add("checking", "2030-01-30", -4_500, "SYNTHETIC CAFE", cat.Dining);
    const month = await series("2030-01-01", "2030-01-31");
    expect(month.totals).toEqual(total(month.days));
    const weeks = rollUp(month.days, "week");
    expect(weeks.reduce((s, w) => s + w.inCents, 0)).toBe(month.totals.inCents);
    expect(weeks.reduce((s, w) => s + w.outCents, 0)).toBe(month.totals.outCents);
    // And a week read on its own matches the same days of the month.
    const week = await series("2030-01-07", "2030-01-13");
    expect(week.days).toEqual(month.days.slice(6, 13));
  });

  it("counts a paycheck with a stub once, as the net that landed, never its deductions as spending", async () => {
    const [deposit] = await db.select().from(transactions).where(like(transactions.description, "SYNTHETIC EMPLOYER PAYROLL"));
    const before = (await series("2030-01-09", "2030-01-09")).totals;
    await run("payStubs.create", {
      employer: "Synthetic Employer",
      periodStart: "2029-12-27",
      periodEnd: "2030-01-09",
      payDate: "2030-01-09",
      grossCents: 400_000,
      netCents: 300_000,
      lines: [
        { kind: "federal_income_tax", label: "Fed W/H", amountCents: 70_000 },
        { kind: "health_insurance", label: "Medical", amountCents: 30_000, categoryId: cat.Fitness },
      ],
      depositTransactionIds: [deposit.id],
    });
    expect((await series("2030-01-09", "2030-01-09")).totals).toEqual(before);
  });
});
