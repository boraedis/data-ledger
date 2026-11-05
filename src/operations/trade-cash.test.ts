import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, commandLog, dailyPrices, holdingSnapshots, tradeHintDismissals, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { testDb } from "@/lib/test-utils/db";
import { planCashRows } from "@/lib/trades/cash-plan";
import { attachCashRows, draftTradeGaps } from "@/lib/trades/draft-gaps";
import { execute, read, undoCommand } from "@/operations/runtime";
import { listTransactions, spendingLines } from "@/operations/transactions";

// Brokerage cash rows attaching to the drafts they settled (#321). Invented
// brokerage, funds, descriptions and amounts.

let db: Db;
let broker: string;
let n = 0;

const run = (operation: string, input: Record<string, unknown>, actor = "user") =>
  execute(db, { operation, input, actor: actor as "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: { id: string } }>;

async function snapshot(on: string, shares: string) {
  await db.insert(holdingSnapshots).values({ accountId: broker, on, externalId: "ZQXV", symbol: "ZQXV", description: "Example Growth Fund", shares, marketValueCents: Math.round(Number(shares) * 12_500), currency: "USD" });
}
async function cash(postedOn: string, amountCents: number, description: string, accountId = broker) {
  const [row] = await db.insert(transactions).values({ accountId, postedOn, amountCents, description, externalId: `cash-${++n}` }).returning();
  return row;
}
const draft = async () => (await db.select().from(trades).where(eq(trades.status, "draft")))[0];

beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
    .returning({ id: accounts.id });
  // Baseline at 10, then 12: a draft buy of 2 between May 2 and May 5.
  await snapshot("2026-05-01", "10");
  await draftTradeGaps(db);
  await snapshot("2026-05-05", "12");
  await draftTradeGaps(db);
  await db.insert(dailyPrices).values({ assetClass: "equity", symbol: "ZQXV", on: "2026-05-04", price: "125", source: "test" });
});

describe("attaching", () => {
  it("gives a draft its cash row's day and price when each is the other's one fit", async () => {
    const row = await cash("2026-05-04", -25_000, "BUY ZQXV EXAMPLE GROWTH FUND");
    expect(await attachCashRows(db)).toBe(1);
    expect(await draft()).toMatchObject({ transactionId: row.id, on: "2026-05-04", onFrom: null, price: "125", status: "draft" });
    // Once is enough.
    expect(await attachCashRows(db)).toBe(0);
  });

  it("keeps the day inside the draft's range when the row settles after it", async () => {
    await cash("2026-05-07", -25_000, "BUY ZQXV");
    await attachCashRows(db);
    expect(await draft()).toMatchObject({ on: "2026-05-05" });
    // And the gap stays closed: nothing is drafted again.
    await snapshot("2026-05-08", "12");
    expect(await draftTradeGaps(db)).toBe(0);
  });

  it("attaches nothing when two rows could be the one draft, and offers both", async () => {
    const a = await cash("2026-05-03", -25_000, "BUY ZQXV");
    const b = await cash("2026-05-04", -25_050, "BUY ZQXV");
    expect(await attachCashRows(db)).toBe(0);
    const plan = await planCashRows(db);
    expect(plan.offers.get((await draft()).id)?.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    // The owner picks one.
    await run("trades.attachCash", { tradeId: (await draft()).id, transactionId: b.id });
    expect(await draft()).toMatchObject({ transactionId: b.id, on: "2026-05-04" });
  });

  it("takes a cash row off again, putting the draft's range back", async () => {
    await cash("2026-05-04", -25_000, "BUY ZQXV");
    await attachCashRows(db);
    await run("trades.detachCash", { tradeId: (await draft()).id });
    expect(await draft()).toMatchObject({ transactionId: null, on: "2026-05-05", onFrom: "2026-05-02", price: null });
  });

  it("is undone with the matcher's command", async () => {
    await cash("2026-05-04", -25_000, "BUY ZQXV");
    await attachCashRows(db);
    const [{ id }] = await db.select({ id: commandLog.id }).from(commandLog).where(eq(commandLog.operation, "trades.matchCash"));
    await undoCommand(db, id);
    expect(await draft()).toMatchObject({ transactionId: null, onFrom: "2026-05-02" });
  });

  it("never touches a trade the owner confirmed: a row for it is only a hint", async () => {
    const d = await draft();
    await run("trades.update", { tradeId: d.id, onFrom: null, on: "2026-05-03" });
    await run("trades.confirm", { tradeId: d.id });
    await cash("2026-05-04", -25_000, "BUY ZQXV");
    expect(await attachCashRows(db)).toBe(0);
    expect((await planCashRows(db)).hints).toHaveLength(1);
    expect((await db.select().from(trades).where(eq(trades.id, d.id)))[0]).toMatchObject({ transactionId: null, price: null });
  });

  it("refuses a row from another account or of the other side, and anyone but the owner or matcher", async () => {
    const [{ id: other }] = await db.insert(accounts).values({ name: "Other", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b2" }).returning({ id: accounts.id });
    const elsewhere = await cash("2026-05-04", -25_000, "BUY ZQXV", other);
    const sale = await cash("2026-05-04", 25_000, "SOLD ZQXV");
    const d = await draft();
    await expect(run("trades.attachCash", { tradeId: d.id, transactionId: elsewhere.id })).rejects.toThrow(/another account/);
    await expect(run("trades.attachCash", { tradeId: d.id, transactionId: sale.id })).rejects.toThrow(/isn't a buy/);
    await expect(run("trades.matchCash", {}, "user")).rejects.toThrow();
    await expect(run("trades.attachCash", { tradeId: d.id, transactionId: sale.id }, "tally")).rejects.toThrow();
  });
});

describe("hints", () => {
  it("lists a recognized row with no draft, ignores unrecognized ones and rows before the baseline, and can be dismissed and undone", async () => {
    const stray = await cash("2026-05-20", -9_000, "BUY ZZIX");
    await cash("2026-05-20", -9_000, "Example transfer");
    await cash("2026-04-20", -9_000, "BUY ZZOLD");
    expect((await planCashRows(db)).hints.map((h) => h.id)).toEqual([stray.id]);

    const dismissed = await run("trades.dismissHint", { transactionId: stray.id });
    expect((await planCashRows(db)).hints).toEqual([]);
    await undoCommand(db, dismissed.commandId);
    expect(await db.select().from(tradeHintDismissals)).toEqual([]);
    expect((await planCashRows(db)).hints).toHaveLength(1);
  });

  it("leaves out a buy of the account's own cash fund: a sweep, whatever it's called (#316)", async () => {
    await db.insert(holdingSnapshots).values({ accountId: broker, on: "2026-05-05", externalId: "ZZCXX", symbol: "ZZCXX", description: "Example Liquid Reserve", shares: "300", marketValueCents: 30_000, currency: "USD" });
    await cash("2026-05-20", -9_000, "BUY ZZCXX");
    expect((await planCashRows(db)).hints).toEqual([]);
  });

  it("becomes a trade by hand, linked to its row, and refuses a row already a trade's", async () => {
    const stray = await cash("2026-05-20", -9_000, "BUY ZZIX");
    const made = await run("trades.add", { accountId: broker, on: "2026-05-20", symbol: "ZZIX", side: "buy", quantity: "1", transactionId: stray.id });
    expect((await db.select().from(trades).where(eq(trades.id, made.output.id)))[0]).toMatchObject({ transactionId: stray.id, status: "confirmed" });
    expect((await planCashRows(db)).hints).toEqual([]);
    await expect(run("trades.add", { accountId: broker, on: "2026-05-20", symbol: "ZZIX", side: "buy", quantity: "1", transactionId: stray.id })).rejects.toThrow(/already/);
  });
});

describe("the cash row in Transactions", () => {
  it("says it settled a trade, with nothing about the trade itself, and isn't spending", async () => {
    const row = await cash("2026-05-04", -25_000, "BUY ZQXV");
    // Even filed under a category, an investment account's row isn't in budgets (#24).
    const [{ id: cat }] = await db.insert(categories).values({ name: "Example spending", kind: "expense" }).returning({ id: categories.id });
    await db.update(transactions).set({ categoryId: cat }).where(eq(transactions.id, row.id));
    await attachCashRows(db);
    const [listed] = (await read(db, listTransactions, { from: "2026-05-04", to: "2026-05-04" })).filter((t) => t.id === row.id);
    expect(listed.trade).toBe("draft");
    expect((await spendingLines.run(db, { budgetOnly: true, gross: true })).map((l) => l.transactionId)).not.toContain(row.id);
  });
});
