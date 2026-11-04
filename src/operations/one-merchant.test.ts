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
// charges, the suspicious-charge checks and Spending, and what the owner
// decided is stored by merchant id.

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
const missingAlert = (merchantId: string) => ({
  kind: "missing_charge" as const,
  dedupeKey: `missing_charge|${merchantId}|${card}|2026-05-03`,
  merchant: "Lumen Streaming",
  merchantId,
  accountId: card,
  title: "t",
  detail: "d",
  occurredOn: "2026-05-03",
  dismissedAt: new Date(),
});

describe("recurring charges", () => {
  it("are one series for a bill charged under two spellings", async () => {
    for (const [i, on] of ["2026-02-03", "2026-03-03", "2026-04-03", "2026-05-03", "2026-06-03"].entries())
      await charge(on, 15.99, i % 2 ? "Lumen Streaming Svc" : "Lumen Streaming");
    const series = await lumenSeries();
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ merchant: "Lumen Streaming", merchantId: lumen, cadence: "monthly" });
  });

  it("keep the owner's decision by merchant: through a rename, onto the kept one in a merge, and back on undo", async () => {
    for (const on of ["2026-03-03", "2026-04-03", "2026-05-03", "2026-06-03"]) await charge(on, 15.99, "Lumen Streaming");
    await run("recurring.setStatus", { merchant: "Lumen Streaming", accountId: card, status: "confirmed" });
    expect(await db.select({ merchantId: recurringSeries.merchantId }).from(recurringSeries)).toEqual([{ merchantId: lumen }]);

    // Renamed: nothing stored changes, and the series shows the new name.
    await run("merchants.rename", { merchantId: lumen, name: "Lumen" });
    expect((await lumenSeries())[0]).toMatchObject({ merchant: "Lumen", merchantId: lumen, status: "confirmed" });

    const [{ id: other }] = await db.insert(merchants).values({ name: "Lumen Media" }).returning();
    const merged = await run("merchants.merge", { keepId: other, mergeId: lumen });
    expect((await lumenSeries())[0]).toMatchObject({ merchant: "Lumen Media", merchantId: other, status: "confirmed" });
    await undoCommand(db, merged.commandId);
    expect(await db.select({ merchantId: recurringSeries.merchantId }).from(recurringSeries)).toEqual([{ merchantId: lumen }]);
  });

  it("move an answered alert's dedupe key in a merge, so it isn't raised again", async () => {
    const [{ id: other }] = await db.insert(merchants).values({ name: "Lumen Media" }).returning();
    await db.insert(alerts).values(missingAlert(lumen));
    await run("merchants.merge", { keepId: other, mergeId: lumen });
    const [moved] = await db.select().from(alerts).where(eq(alerts.kind, "missing_charge"));
    expect(moved).toMatchObject({ merchantId: other, dedupeKey: `missing_charge|${other}|${card}|2026-05-03` });
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

  it("store a flag with its merchant, so a verdict tunes every spelling", async () => {
    const big = await charge("2026-07-02", 320, "Lumen Streaming Svc");
    await run("alerts.checkSuspicious", { on: "2026-07-04" }, "matcher");
    const [flag] = await db.select().from(alerts).where(eq(alerts.transactionId, big.id));
    expect(flag).toMatchObject({ kind: "new_merchant", merchantId: lumen, merchant: "Lumen Streaming" });
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
  it("ties decisions and alerts to the merchant their name is a spelling of, keeping one decision per account", async () => {
    // As before it ran: by name only, with two spellings deciding in one account.
    await db.execute(sql`drop index "recurring_series_merchant_id_account_idx"`);
    await db.insert(recurringSeries).values([
      { merchant: "Lumen Streaming Svc", accountId: card, status: "dismissed", createdAt: new Date("2026-01-01") },
      { merchant: "Lumen Streaming", accountId: card, status: "confirmed", createdAt: new Date("2025-01-01") },
    ]);
    await db.insert(alerts).values({ ...missingAlert(lumen), merchantId: null, merchant: "Lumen Streaming Svc", dedupeKey: `missing_charge|Lumen Streaming Svc|${card}|2026-05-03` });

    // The data statements, between adding the columns and creating the new indexes.
    const statements = readFileSync("drizzle/0042_one_merchant.sql", "utf8").split("--> statement-breakpoint");
    const data = statements.filter((st) => /^(UPDATE|DELETE|WITH)\b/m.test(st));
    expect(data).toHaveLength(4);
    for (const statement of data) await db.execute(sql.raw(statement));

    // The one under the merchant's name won.
    expect(await db.select({ merchantId: recurringSeries.merchantId, status: recurringSeries.status }).from(recurringSeries)).toEqual([
      { merchantId: lumen, status: "confirmed" },
    ]);
    const [moved] = await db.select().from(alerts).where(eq(alerts.kind, "missing_charge"));
    expect(moved).toMatchObject({ merchantId: lumen, dedupeKey: `missing_charge|${lumen}|${card}|2026-05-03` });
  });
});
