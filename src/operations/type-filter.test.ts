import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, alerts, categories, payStubDeposits, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read } from "@/operations/runtime";
import { listTransactions, transactionTypeCounts } from "@/operations/transactions";

// The Transactions page's type filter (#208), on the synthetic seed, which
// comes with pay stubs linked to its paychecks. Merchants and amounts are
// invented.

let db: Db;
let cat: Record<string, string>;
let card: string;

const TYPES = ["unmatchedTransfers", "uncategorized", "payStubLinked", "flagged"] as const;
const list = (type: (typeof TYPES)[number], input: Record<string, unknown> = {}) =>
  read(db, listTransactions, { [type]: true, limit: 500, ...input });
const idsOf = async (type: (typeof TYPES)[number], input: Record<string, unknown> = {}) => (await list(type, input)).map((r) => r.id);
const user = (operation: string, input: Record<string, unknown>) => execute(db, { operation, input, actor: "user", reason: "test" });

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
});

async function charge(dollars: number, merchant: string) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: card, postedOn: "2026-06-20", amountCents: -Math.round(dollars * 100), description: merchant.toUpperCase(), merchant, externalId: `type-${merchant}` })
    .returning();
  return row;
}

describe("the type filter (#208)", () => {
  it("shows an uncategorized charge under Uncategorized and nowhere else", async () => {
    const lamp = await charge(42.5, "Brightwick Lamps");
    expect(await idsOf("uncategorized")).toContain(lamp.id);
    expect(await idsOf("unmatchedTransfers")).not.toContain(lamp.id);
    expect(await idsOf("payStubLinked")).not.toContain(lamp.id);

    await user("transactions.setCategory", { transactionId: lamp.id, categoryId: cat.Groceries });
    expect(await idsOf("uncategorized")).not.toContain(lamp.id);
  });

  it("leaves a paired transfer out of Uncategorized: its transfer badge says what it is", async () => {
    const [payment] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(1);
    const [credit] = await db.select().from(transactions).where(eq(transactions.amountCents, -payment.amountCents));
    await db.update(transactions).set({ categoryId: null }).where(eq(transactions.id, payment.id));
    await user("transactions.pairAsTransfer", { outId: payment.id, inId: credit.id });
    expect(await idsOf("uncategorized")).not.toContain(payment.id);
  });

  it("shows a paycheck deposit linked to a pay stub under Connected to a pay stub", async () => {
    const linked = await db.select({ id: payStubDeposits.transactionId }).from(payStubDeposits);
    expect(linked.length).toBeGreaterThan(0);
    const rows = await list("payStubLinked");
    expect(rows.map((r) => r.id).sort()).toEqual(linked.map((l) => l.id).sort());
    expect(rows.every((r) => r.payStub !== null && r.amountCents > 0)).toBe(true);
  });

  it("counts on each option the rows the list shows, under the other filters too", async () => {
    await charge(42.5, "Brightwick Lamps");
    for (const filters of [{}, { accountId: card }, { from: "2026-06-01", to: "2026-06-30" }, { search: "brightwick" }]) {
      const counts = await read(db, transactionTypeCounts, filters);
      for (const type of TYPES) expect(counts[type], `${type} with ${JSON.stringify(filters)}`).toBe((await list(type, filters)).length);
    }
    expect((await read(db, transactionTypeCounts, { search: "brightwick" })).uncategorized).toBe(1);
  });

  describe("Flagged (#210)", () => {
    const flaggedIds = () => idsOf("flagged");
    const flag = async (transactionId: string) => {
      const [row] = await db
        .insert(alerts)
        .values({ kind: "new_merchant", dedupeKey: `test-${transactionId}`, merchant: "Brightwick Lamps", accountId: card, transactionId, title: "t", detail: "d", occurredOn: "2026-06-20", amountCents: 32_000 })
        .returning();
      return row.id;
    };
    const tagOf = async (id: string) => (await read(db, listTransactions, { search: "brightwick", limit: 500 })).find((r) => r.id === id)!.flagged;

    it("tags a flagged charge until it's called fine, and the filter lists exactly the tagged rows", async () => {
      const lamp = await charge(320, "Brightwick Lamps");
      expect(await tagOf(lamp.id)).toBe(false);
      const alertId = await flag(lamp.id);
      expect(await tagOf(lamp.id)).toBe(true);
      expect(await flaggedIds()).toEqual([lamp.id]);

      await user("alerts.review", { alertId, verdict: "fine" });
      expect(await tagOf(lamp.id)).toBe(false);
      expect(await flaggedIds()).toEqual([]);
    });

    it("keeps the tag, and the row in the filter, once it's called suspicious", async () => {
      const lamp = await charge(320, "Brightwick Lamps");
      const alertId = await flag(lamp.id);
      await user("alerts.review", { alertId, verdict: "suspicious" });
      expect(await tagOf(lamp.id)).toBe(true);
      expect(await flaggedIds()).toEqual([lamp.id]);
    });

    it("ignores other alerts on a charge, such as a price increase", async () => {
      const lamp = await charge(320, "Brightwick Lamps");
      await db.insert(alerts).values({ kind: "price_increase", dedupeKey: "test", merchant: "Brightwick Lamps", accountId: card, transactionId: lamp.id, title: "t", detail: "d", occurredOn: "2026-06-20" });
      expect(await tagOf(lamp.id)).toBe(false);
    });
  });
});
