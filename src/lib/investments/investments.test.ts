import { and, eq, isNotNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// End to end on the synthetic seed: monthly contributions from checking to
// the brokerage, buys, reinvested dividends and cash interest (#24).

let db: Db;
let brokerageId: string;
let checkingId: string;

const run = (operation: string, input: Record<string, unknown>, actor: "user" = "user") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<{ commandId: string; output: unknown }>;

const contributions = () =>
  db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, checkingId), eq(transactions.description, "ONLINE TRANSFER TO EXAMPLE BROKERAGE XXXXXX")));

async function inboxIds() {
  const { output } = await run("transactions.inbox", { limit: 500 });
  return new Set((output as { id: string }[]).map((r) => r.id));
}

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: brokerageId }] = await db.select().from(accounts).where(eq(accounts.type, "brokerage"));
  [{ id: checkingId }] = await db.select().from(accounts).where(eq(accounts.type, "checking"));
});

describe("investment activity", () => {
  it("never puts brokerage transactions in the inbox or spending", async () => {
    const inbox = await inboxIds();
    const brokerage = await db.select().from(transactions).where(eq(transactions.accountId, brokerageId));
    expect(brokerage.length).toBeGreaterThan(10);
    expect(brokerage.some((t) => inbox.has(t.id))).toBe(false);

    // Even if one is categorized, budget spending leaves it out.
    const [cat] = await db.insert(categories).values({ name: "Investing", kind: "expense" }).returning();
    await run("transactions.setCategory", { transactionId: brokerage[0].id, categoryId: cat.id });
    const { output } = await run("transactions.spendingLines", {});
    expect((output as { transactionId: string }[]).some((l) => l.transactionId === brokerage[0].id)).toBe(false);
  });

  it("pairs each contribution with its deposit as one matcher command, out of the inbox", async () => {
    const before = await contributions();
    expect(before.every((t) => t.transferPairId === null)).toBe(true);
    const inboxBefore = await inboxIds();
    expect(before.every((t) => inboxBefore.has(t.id))).toBe(true);

    const result = await runCategorization(db);
    // The seed's card payments and savings moves pair too, in their own commands.
    expect(result.transfers).toBeGreaterThanOrEqual(before.length);
    const after = await contributions();
    const pairs = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, brokerageId), isNotNull(transactions.transferPairId)));
    expect(pairs.map((p) => p.description)).toEqual(Array(before.length).fill("ACH DEPOSIT FROM BANK"));
    for (const t of after) expect(pairs.find((p) => p.id === t.transferPairId)?.transferPairId).toBe(t.id);

    const inboxAfter = await inboxIds();
    expect(after.some((t) => inboxAfter.has(t.id))).toBe(false);
    const log = await db.select().from(commandLog).where(eq(commandLog.actor, "matcher"));
    expect(log.filter((c) => c.reason.includes("investment"))).toHaveLength(1);
    // A second run finds nothing new.
    expect((await runCategorization(db)).transfers).toBe(0);
  });

  it("shows transfers and activity on transactions", async () => {
    await runCategorization(db);
    const [contribution] = await contributions();
    const { output } = await run("transactions.get", { transactionId: contribution.id });
    expect(output).toMatchObject({ transfer: { accountId: brokerageId }, investmentActivity: null });
    const { output: list } = await run("transactions.list", { accountId: brokerageId, limit: 500 });
    const activities = new Set((list as { investmentActivity: string }[]).map((t) => t.investmentActivity));
    expect([...activities].sort()).toEqual(["buy", "dividend", "interest", "reinvestment", "transfer"]);
  });

  it("'not a transfer' puts both sides back and the matcher leaves them alone; undo works", async () => {
    await runCategorization(db);
    const [contribution] = await contributions();
    const { commandId } = await run("transactions.unmatchTransfer", { transactionId: contribution.id });
    expect((await inboxIds()).has(contribution.id)).toBe(true);
    await runCategorization(db);
    const [again] = await db.select().from(transactions).where(eq(transactions.id, contribution.id));
    expect(again).toMatchObject({ transferPairId: null, transferRejected: true });

    await undoCommand(db, commandId);
    const [restored] = await db.select().from(transactions).where(eq(transactions.id, contribution.id));
    expect(restored.transferPairId).not.toBeNull();
  });

  it("refuses pairs that don't add up", async () => {
    const [a] = await contributions();
    const [buy] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, brokerageId), eq(transactions.description, "INTEREST ON CASH SWEEP")));
    await expect(run("transactions.matchTransfers", { pairs: [{ cashId: a.id, investmentId: buy.id }] })).rejects.toThrow(/opposite/);
    await expect(run("transactions.matchTransfers", { pairs: [{ cashId: a.id, investmentId: a.id }] })).rejects.toThrow(/same account/);
  });

  it("reports dividends and interest as investment income, not reinvestments or deposits", async () => {
    const all = await db.select().from(transactions).where(eq(transactions.accountId, brokerageId));
    const dividends = all.filter((t) => t.description === "DIVIDEND RECEIVED EXTM").reduce((s, t) => s + t.amountCents, 0);
    const interest = all.filter((t) => t.description === "INTEREST ON CASH SWEEP").reduce((s, t) => s + t.amountCents, 0);
    const { output } = await run("investments.income", {});
    expect(output).toMatchObject({ dividendsCents: dividends, interestCents: interest, totalCents: dividends + interest });
    expect(dividends).toBeGreaterThan(0);
  });
});
