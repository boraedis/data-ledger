import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, payStubDeposits, payStubLines, payStubs, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { linkPayStubsStep } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listPayStubs } from "@/operations/pay";
import { execute, undoCommand } from "@/operations/runtime";
import { spendingLines } from "@/operations/transactions";

// Pay stubs against the synthetic seed: its paychecks are the deposits,
// and the stubs are made up to fit them. No real pay stub anywhere.

let db: Db;
let cat: Record<string, string>;
let paycheck: typeof transactions.$inferSelect;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  await db.update(transactions).set({ categoryId: cat.Paycheck }).where(like(transactions.description, "ACME WIDGETS%"));
  [paycheck] = await db.select().from(transactions).where(like(transactions.description, "ACME WIDGETS%")).orderBy(transactions.postedOn).limit(1);
});

const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, actor: "user", reason: "Test", input });

/** A synthetic stub whose net is the given deposit. */
function stubFor(deposit: { postedOn: string; amountCents: number }, extra: Record<string, unknown> = {}) {
  const lines = [
    { kind: "federal_income_tax", label: "Fed W/H", amountCents: 41_000, categoryId: cat.Utilities },
    { kind: "social_security", label: "OASDI", amountCents: 18_600 },
    { kind: "medicare", label: "Medicare", amountCents: 4_350 },
    { kind: "health_insurance", label: "Medical", amountCents: 6_050, categoryId: cat.Fitness },
  ];
  const withheld = lines.reduce((s, l) => s + l.amountCents, 0);
  return {
    employer: "Acme Widgets",
    periodStart: "2026-01-01",
    periodEnd: deposit.postedOn,
    payDate: deposit.postedOn,
    grossCents: deposit.amountCents + withheld,
    netCents: deposit.amountCents,
    lines,
    ...extra,
  };
}

describe("payStubs", () => {
  it("links the deposit, and budgets count gross pay plus each deduction instead of the net", async () => {
    const result = await run("payStubs.create", stubFor(paycheck));
    expect((result as { output: { depositTransactionIds: string[] } }).output.depositTransactionIds).toEqual([paycheck.id]);

    const lines = (await spendingLines.run(db, { from: paycheck.postedOn, to: paycheck.postedOn, budgetOnly: true, gross: false })).filter(
      (l) => l.transactionId === paycheck.id,
    );
    const stub = stubFor(paycheck);
    // Social Security and Medicare have no category: netted against gross.
    expect(lines.map((l) => [l.categoryId, l.amountCents])).toEqual([
      [cat.Paycheck, stub.grossCents - 18_600 - 4_350],
      [cat.Utilities, -41_000],
      [cat.Fitness, -6_050],
    ]);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(paycheck.amountCents);
  });

  it("refuses a stub that doesn't add up, or a deposit that isn't the net", async () => {
    await expect(run("payStubs.create", { ...stubFor(paycheck), netCents: paycheck.amountCents + 1 })).rejects.toThrow(/off by \$0\.01/);
    const [other] = await db.select().from(transactions).where(like(transactions.description, "INTEREST PAYMENT%")).limit(1);
    await expect(run("payStubs.create", stubFor(paycheck, { depositTransactionIds: [other.id] }))).rejects.toThrow(/exactly the net/);
  });

  it("edits, deletes and undoes cleanly, and summarises by group", async () => {
    const { output } = (await run("payStubs.create", stubFor(paycheck))) as { output: { payStubId: string } };
    const mine = async () => (await listPayStubs.run(db, {})).find((s) => s.id === output.payStubId);
    const listed = (await mine())!;
    expect(listed.totals).toEqual({ tax: 41_000 + 18_600 + 4_350, insurance: 6_050, retirement: 0, other: 0 });

    const edited = stubFor(paycheck, { employer: "Acme Widgets Inc", payStubId: output.payStubId });
    await run("payStubs.update", edited);
    expect(await mine()).toMatchObject({ employer: "Acme Widgets Inc", deposits: [{ id: paycheck.id, amountCents: paycheck.amountCents }] });

    const deleted = await run("payStubs.delete", { payStubId: output.payStubId });
    expect(await mine()).toBeUndefined();
    expect(await db.select().from(payStubLines).where(eq(payStubLines.payStubId, output.payStubId))).toEqual([]);
    await undoCommand(db, (deleted as { commandId: string }).commandId);
    expect(await db.select().from(payStubLines).where(eq(payStubLines.payStubId, output.payStubId))).toHaveLength(4);
    expect(await db.select().from(payStubDeposits).where(eq(payStubDeposits.payStubId, output.payStubId))).toHaveLength(1);
  });

  it("links a stub entered before payday once the deposit posts", async () => {
    const payday = { postedOn: "2026-07-10", amountCents: 245_123 };
    await run("payStubs.create", stubFor(payday));
    const [stub] = await db.select().from(payStubs).where(eq(payStubs.payDate, "2026-07-10"));
    expect(await db.select().from(payStubDeposits).where(eq(payStubDeposits.payStubId, stub.id))).toEqual([]);
    const [deposit] = await db
      .insert(transactions)
      .values({ accountId: paycheck.accountId, postedOn: "2026-07-10", amountCents: 245_123, description: "ACME WIDGETS INC DIRECT DEP PAYROLL", externalId: "later" })
      .returning();
    expect(await linkPayStubsStep(db)).toBe(1);
    expect(await db.select().from(payStubDeposits).where(and(eq(payStubDeposits.payStubId, stub.id), eq(payStubDeposits.transactionId, deposit.id)))).toHaveLength(1);
  });

  it("links pay split across two accounts, and budgets still count gross pay plus deductions (#91)", async () => {
    const payday = { postedOn: "2026-07-10", amountCents: 245_123 };
    const { output } = (await run("payStubs.create", stubFor(payday))) as { output: { payStubId: string } };
    const [savings] = await db.select().from(accounts).where(eq(accounts.type, "savings"));
    const descriptor = "ACME WIDGETS INC DIRECT DEP PAYROLL";
    const merchant = "Acme Widgets Inc Direct Dep Payroll";
    const deposit = (accountId: string, amountCents: number, externalId: string) => ({ accountId, postedOn: "2026-07-10", amountCents, description: descriptor, merchant, categoryId: cat.Paycheck, externalId });
    const [toChecking, toSavings] = await db
      .insert(transactions)
      .values([deposit(paycheck.accountId, 195_123, "split-checking"), deposit(savings.id, 50_000, "split-savings")])
      .returning();

    expect(await linkPayStubsStep(db)).toBe(1);
    const listed = (await listPayStubs.run(db, {})).find((s) => s.id === output.payStubId)!;
    expect(listed.deposits.map((d) => [d.id, d.amountCents])).toEqual([
      [toChecking.id, 195_123],
      [toSavings.id, 50_000],
    ]);

    // Gross and deductions expand onto the larger deposit, less the other,
    // which counts as itself: together, exactly both deposits.
    const lines = (await spendingLines.run(db, { from: "2026-07-10", to: "2026-07-10", budgetOnly: false, gross: false })).filter(
      (l) => l.transactionId === toChecking.id || l.transactionId === toSavings.id,
    );
    const stub = stubFor(payday);
    expect(lines.filter((l) => l.transactionId === toChecking.id).map((l) => [l.categoryId, l.amountCents])).toEqual([
      [cat.Paycheck, stub.grossCents - 50_000 - 18_600 - 4_350],
      [cat.Utilities, -41_000],
      [cat.Fitness, -6_050],
    ]);
    expect(lines.filter((l) => l.transactionId === toSavings.id).map((l) => l.amountCents)).toEqual([50_000]);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(245_123);
  });

  it("links deposits by hand only when they add up to the net", async () => {
    const payday = { postedOn: "2026-07-10", amountCents: 245_123 };
    const { output } = (await run("payStubs.create", stubFor(payday, { depositTransactionIds: null }))) as { output: { payStubId: string } };
    const [a, b] = await db
      .insert(transactions)
      .values([
        { accountId: paycheck.accountId, postedOn: "2026-07-10", amountCents: 200_000, description: "PAYROLL A", externalId: "hand-a" },
        { accountId: paycheck.accountId, postedOn: "2026-07-11", amountCents: 45_000, description: "PAYROLL B", externalId: "hand-b" },
      ])
      .returning();
    await expect(run("payStubs.linkDeposit", { payStubId: output.payStubId, depositTransactionIds: [a.id, b.id] })).rejects.toThrow(/add up to exactly/);
    await db.update(transactions).set({ amountCents: 45_123 }).where(eq(transactions.id, b.id));
    await run("payStubs.linkDeposit", { payStubId: output.payStubId, depositTransactionIds: [a.id, b.id] });
    expect((await listPayStubs.run(db, {})).find((s) => s.id === output.payStubId)!.deposits).toHaveLength(2);
  });
});

it("seeds three synthetic stubs, each linked to its paycheck and adding up", async () => {
  const stubs = await listPayStubs.run(db, {});
  expect(stubs).toHaveLength(3);
  for (const s of stubs) {
    expect(s.deposits).toHaveLength(1);
    expect(s.grossCents - s.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(s.netCents);
  }
});
