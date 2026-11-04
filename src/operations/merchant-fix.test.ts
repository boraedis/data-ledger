import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, merchantAliases, merchants, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillMerchantsIfNeeded } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { similarTransactions } from "@/operations/merchants";
import { execute, read, undoCommand } from "@/operations/runtime";

// Fixing a transaction's merchant by hand (#291), on the synthetic seed
// with invented merchants and descriptions.

let db: Db;
let p2p: string;
const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;
const addManual = async (description: string) =>
  ((await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -900, description })).output as { transactionId: string }).transactionId;
const txn = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const merchantId = async (name: string) => (await db.select().from(merchants).where(eq(merchants.name, name)))[0]?.id;

let a: string;
let b: string;
let c: string;
let juniper: string;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
  a = await addManual("PAYMENT TO JH 2231");
  b = await addManual("PAYMENT TO JH 2231");
  c = await addManual("PAYMENT TO JH 2231");
  await addManual("Juniper Hardware");
  juniper = await merchantId("Juniper Hardware");
});

describe("fixing a transaction's merchant", () => {
  it("counts the same-description ones first, then moves them all, pinned; undo puts every one back", async () => {
    expect(await read(db, similarTransactions, { transactionId: a })).toEqual({ transactions: 2, alreadyChosen: 0 });
    const before = (await txn(a)).merchantId;
    const fixed = await run("merchants.setForTransaction", { transactionId: a, merchantId: juniper, similar: true });
    expect(fixed.output).toMatchObject({ merchantId: juniper, transactions: 3 });
    for (const id of [a, b, c]) expect(await txn(id)).toMatchObject({ merchantId: juniper, merchantPinned: true, merchant: "Payment to Jh" });
    await undoCommand(db, fixed.commandId);
    for (const id of [a, b, c]) expect(await txn(id)).toMatchObject({ merchantId: before, merchantPinned: false });
  });

  it("changes only the one without similar, and makes a new merchant by name", async () => {
    await run("merchants.setForTransaction", { transactionId: a, name: "Juniper Garden Supply" });
    const made = await merchantId("Juniper Garden Supply");
    expect(made).toBeDefined();
    expect((await txn(a)).merchantId).toBe(made);
    expect((await txn(b)).merchantPinned).toBe(false);
    // A pinned one is counted apart and left alone by the next similar fix.
    expect(await read(db, similarTransactions, { transactionId: b })).toEqual({ transactions: 1, alreadyChosen: 1 });
    await run("merchants.setForTransaction", { transactionId: b, merchantId: juniper, similar: true });
    expect((await txn(a)).merchantId).toBe(made);
  });

  it("stays put through the nightly relink, a cleanup re-run and a split, and follows a merge of its merchant", async () => {
    const own = (await txn(a)).merchantId!;
    await run("merchants.setForTransaction", { transactionId: a, merchantId: juniper });
    await backfillMerchantsIfNeeded(db);
    await run("merchants.rederive", {});
    expect((await txn(a)).merchantId).toBe(juniper);

    // Its spelling merged into Juniper Hardware and split back out: the split takes the unpinned ones only.
    await run("merchants.merge", { keepId: juniper, mergeId: own });
    const [alias] = await db.select().from(merchantAliases).where(eq(merchantAliases.alias, "Payment to Jh"));
    await run("merchants.splitAlias", { aliasId: alias.id });
    expect((await txn(a)).merchantId).toBe(juniper);
    expect((await txn(b)).merchantId).not.toBe(juniper);

    const [{ id: other }] = await db.insert(merchants).values({ name: "Juniper Hardware Co" }).returning();
    await run("merchants.merge", { keepId: other, mergeId: juniper });
    expect(await txn(a)).toMatchObject({ merchantId: other, merchantPinned: true });
  });

  it("lets go of a pin, back to the merchant its name belongs to", async () => {
    const own = (await txn(a)).merchantId;
    await run("merchants.setForTransaction", { transactionId: a, merchantId: juniper });
    await run("merchants.unpinTransaction", { transactionId: a });
    expect(await txn(a)).toMatchObject({ merchantId: own, merchantPinned: false });
  });

  it("needs exactly one of a merchant or a name", async () => {
    await expect(run("merchants.setForTransaction", { transactionId: a })).rejects.toThrow(/Pick a merchant/);
    await expect(run("merchants.setForTransaction", { transactionId: a, merchantId: juniper, name: "X Y" })).rejects.toThrow(/Pick a merchant/);
  });
});
