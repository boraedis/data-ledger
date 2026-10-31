import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read } from "@/operations/runtime";
import { listTransactions } from "@/operations/transactions";

// The Transactions page's Unmatched filter (#184), on the synthetic seed. All
// data invented.

let db: Db;
let cat: Record<string, string>;
let grocery: typeof transactions.$inferSelect;
let payment: typeof transactions.$inferSelect;
let credit: typeof transactions.$inferSelect;

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const unmatched = (input: Record<string, unknown> = {}) => read(db, listTransactions, { unmatchedTransfers: true, limit: 500, ...input });

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  [grocery] = await db.select().from(transactions).where(eq(transactions.merchant, "Quillfield Market")).limit(1);
  [payment] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(1);
  [credit] = await db.select().from(transactions).where(eq(transactions.amountCents, -payment.amountCents));
});

describe("transactions.list unmatchedTransfers (#184)", () => {
  it("lists a transfer with no other half, and leaves out one that has been paired", async () => {
    // A grocery charge filed as a transfer has no matching deposit.
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Transfers });
    // A card payment is paired with its credit.
    await user("transactions.pairAsTransfer", { outId: payment.id, inId: credit.id });
    expect((await row(payment.id)).transferPairId).not.toBeNull();

    const ids = (await unmatched()).map((r) => r.id);
    expect(ids).toContain(grocery.id);
    expect(ids).not.toContain(payment.id);
    expect(ids).not.toContain(credit.id);
  });

  it("leaves out anything not filed as a transfer, even with no other half", async () => {
    expect((await unmatched()).every((r) => r.categoryId !== null)).toBe(true);
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Groceries });
    expect((await unmatched()).map((r) => r.id)).not.toContain(grocery.id);
  });

  it("combines with an account and a date range at once", async () => {
    await user("transactions.setCategory", { transactionId: grocery.id, categoryId: cat.Transfers });
    const sameAccount = { accountId: grocery.accountId };
    const otherAccount = (await db.select().from(accounts)).find((a) => a.id !== grocery.accountId)!.id;
    expect((await unmatched(sameAccount)).map((r) => r.id)).toContain(grocery.id);
    expect((await unmatched({ accountId: otherAccount })).map((r) => r.id)).not.toContain(grocery.id);
    expect((await unmatched({ ...sameAccount, to: grocery.postedOn })).map((r) => r.id)).toContain(grocery.id);
    expect((await unmatched({ ...sameAccount, from: "2099-01-01" })).map((r) => r.id)).toEqual([]);
  });
});
