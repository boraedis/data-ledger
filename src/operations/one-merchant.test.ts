import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, alerts, categories, merchantAliases, merchants, recurringSeries, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listRecurring } from "@/operations/recurring";
import { execute, read, undoCommand } from "@/operations/runtime";
import { spendingLines } from "@/operations/transactions";

// One merchant everywhere (#292), on the synthetic seed with invented
// merchants: a merchant spelled two ways is one merchant to recurring
// charges, the suspicious-charge checks and Spending.

let db: Db;
let card: string;
let lumen: string;

type Applied = { status: string; commandId: string; output: unknown };
const run = (operation: string, input: Record<string, unknown>, actor = "user") => execute(db, { operation, actor, reason: "Test", input } as never) as Promise<Applied>;

let n = 0;
async function charge(postedOn: string, dollars: number, merchant: string, merchantId: string | null = lumen) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: card, postedOn, amountCents: -Math.round(dollars * 100), description: merchant.toUpperCase(), merchant, merchantId, externalId: `one-${++n}` })
    .returning();
  return row;
}

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  [{ id: lumen }] = await db.insert(merchants).values({ name: "Lumen Streaming" }).returning();
  await db.insert(merchantAliases).values([
    { alias: "Lumen Streaming", merchantId: lumen },
    { alias: "Lumen Streaming Svc", merchantId: lumen },
  ]);
});

const lumenSeries = async () => (await read(db, listRecurring, { on: "2026-06-30" })).filter((s) => s.merchant.startsWith("Lumen"));

describe("recurring charges", () => {
  it("are one series for a bill charged under two spellings", async () => {
    for (const [i, on] of ["2026-02-03", "2026-03-03", "2026-04-03", "2026-05-03", "2026-06-03"].entries())
      await charge(on, 15.99, i % 2 ? "Lumen Streaming Svc" : "Lumen Streaming");
    const series = await lumenSeries();
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ merchant: "Lumen Streaming", cadence: "monthly" });
  });

  it("keep the owner's decision through a rename and a merge, and undo puts it back", async () => {
    for (const on of ["2026-03-03", "2026-04-03", "2026-05-03", "2026-06-03"]) await charge(on, 15.99, "Lumen Streaming");
    await run("recurring.setStatus", { merchant: "Lumen Streaming", accountId: card, status: "confirmed" });
    const renamed = await run("merchants.rename", { merchantId: lumen, name: "Lumen" });
    expect((await lumenSeries())[0]).toMatchObject({ merchant: "Lumen", status: "confirmed" });

    // Merged into another merchant, the decision goes with the series.
    const [{ id: other }] = await db.insert(merchants).values({ name: "Lumen Media" }).returning();
    const merged = await run("merchants.merge", { keepId: other, mergeId: lumen });
    expect((await lumenSeries())[0]).toMatchObject({ merchant: "Lumen Media", status: "confirmed" });
    await undoCommand(db, merged.commandId);
    await undoCommand(db, renamed.commandId);
    expect(await db.select({ merchant: recurringSeries.merchant }).from(recurringSeries).where(eq(recurringSeries.accountId, card))).toEqual([
      { merchant: "Lumen Streaming" },
    ]);
  });
});

describe("the suspicious-charge checks", () => {
  it("know a new spelling of a known merchant isn't a first-time merchant", async () => {
    await charge("2026-03-10", 300, "Lumen Streaming");
    const big = await charge("2026-07-02", 320, "Lumen Streaming Svc");
    await run("alerts.checkSuspicious", { on: "2026-07-04" }, "matcher");
    const flags = await db.select().from(alerts).where(eq(alerts.transactionId, big.id));
    expect(flags.filter((f) => f.kind === "new_merchant")).toHaveLength(0);
  });
});

describe("Spending", () => {
  it("names every spelling by its merchant", async () => {
    const a = await charge("2026-06-10", 12, "Lumen Streaming");
    const b = await charge("2026-06-11", 12, "Lumen Streaming Svc");
    // Uncategorized lines aren't spending; give them a category to count.
    const [{ id: cat }] = await db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "expense")).limit(1);
    await db.update(transactions).set({ categoryId: cat }).where(sql`${transactions.id} in (${a.id}, ${b.id})`);
    const lines = (await spendingLines.run(db, { budgetOnly: false, gross: true })).filter((l) => [a.id, b.id].includes(l.transactionId));
    expect(lines.map((l) => l.merchant)).toEqual(["Lumen Streaming", "Lumen Streaming"]);
  });
});

describe("the migration", () => {
  it("moves decisions and alerts from a spelling to its merchant, keeping one decision per account", async () => {
    await db.insert(recurringSeries).values([
      { merchant: "Lumen Streaming Svc", accountId: card, status: "dismissed", createdAt: new Date("2026-01-01") },
      { merchant: "Lumen Streaming", accountId: card, status: "confirmed", createdAt: new Date("2025-01-01") },
    ]);
    await db.insert(alerts).values({
      kind: "unusual_amount",
      dedupeKey: "missing_charge|Lumen Streaming Svc|x|2026-05-03",
      merchant: "Lumen Streaming Svc",
      accountId: card,
      title: "t",
      detail: "d",
      occurredOn: "2026-05-03",
      verdict: "fine",
      dismissedAt: new Date(),
      amountCents: 1599,
    });
    const file = readFileSync("drizzle/0042_one_merchant.sql", "utf8");
    for (const statement of file.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    // The one already under the merchant's name won.
    expect(await db.select({ merchant: recurringSeries.merchant, status: recurringSeries.status }).from(recurringSeries)).toEqual([
      { merchant: "Lumen Streaming", status: "confirmed" },
    ]);
    const [moved] = await db.select().from(alerts).where(eq(alerts.amountCents, 1599));
    expect(moved).toMatchObject({ merchant: "Lumen Streaming", dedupeKey: "missing_charge|Lumen Streaming|x|2026-05-03", verdict: "fine" });
  });
});
