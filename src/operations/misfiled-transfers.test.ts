import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read, undoCommand } from "@/operations/runtime";
import { misfiledTransfers, spendingLines } from "@/operations/transactions";

// Transfers filed as spending or income (#102), on the synthetic seed: its
// card payments ("PLACEHOLDER CARD CO PAYMENT" out of checking, "PAYMENT
// THANK YOU" onto the card) stand in for one a rule filed wrongly.

let db: Db;
let cat: Record<string, string>;
let payment: typeof transactions.$inferSelect;
let credit: typeof transactions.$inferSelect;

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const counted = async () => (await read(db, spendingLines, {})).filter((l) => l.transactionId === payment.id || l.transactionId === credit.id);

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  [payment] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(1);
  [credit] = await db.select().from(transactions).where(eq(transactions.amountCents, -payment.amountCents));
  // Filed as spending before the matcher saw it, as a rule would.
  await user("transactions.setCategory", { transactionId: payment.id, categoryId: cat.Dining });
  await runCategorization(db);
});

describe("transactions.misfiledTransfers", () => {
  it("finds a card payment filed as spending, with its other half, and nothing the matcher handles", async () => {
    expect(credit.description).toBe("PAYMENT THANK YOU");
    const found = await read(db, misfiledTransfers, {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      out: { transactionId: payment.id, categoryName: "Dining", accountName: "Everyday Checking" },
      in: { transactionId: credit.id, categoryName: null, accountName: "Rewards Card" },
    });
  });

  it("leaves out a pair filed as a transfer, and keeps to the period by either side's date", async () => {
    await user("transactions.setCategory", { transactionId: payment.id, categoryId: cat.Transfers });
    expect(await read(db, misfiledTransfers, {})).toEqual([]);
    await user("transactions.setCategory", { transactionId: payment.id, categoryId: cat.Dining });
    expect(await read(db, misfiledTransfers, { from: "1990-01-01", to: "1990-12-31" })).toEqual([]);
    expect(await read(db, misfiledTransfers, { from: payment.postedOn, to: payment.postedOn })).toHaveLength(1);
  });
});

describe("settling a flagged pair", () => {
  it("pairs it as a transfer, so it no longer counts, and undo restores it", async () => {
    expect(await counted()).toHaveLength(1);
    const result = await user("transactions.pairAsTransfer", { outId: payment.id, inId: credit.id });
    expect(await row(payment.id)).toMatchObject({ categoryId: null, transferPairId: credit.id });
    expect(await row(credit.id)).toMatchObject({ categoryId: null, transferPairId: payment.id });
    expect(await counted()).toEqual([]);
    expect(await read(db, misfiledTransfers, {})).toEqual([]);

    await undoCommand(db, result.commandId);
    expect(await row(payment.id)).toMatchObject({ categoryId: cat.Dining, transferPairId: null });
    expect(await counted()).toHaveLength(1);
  });

  it("refuses what isn't a transfer's two sides", async () => {
    const [other] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(2).offset(1);
    await expect(user("transactions.pairAsTransfer", { outId: payment.id, inId: other.id })).rejects.toThrow(/opposite amounts|same account/);
  });

  it("dismisses it as not a transfer: categories stay, and it isn't flagged or matched again", async () => {
    await user("transactions.dismissTransfer", { transactionIds: [payment.id, credit.id] });
    expect(await read(db, misfiledTransfers, {})).toEqual([]);
    await runCategorization(db);
    expect(await row(payment.id)).toMatchObject({ categoryId: cat.Dining, transferPairId: null });
    expect(await row(credit.id)).toMatchObject({ transferPairId: null });
  });
});
