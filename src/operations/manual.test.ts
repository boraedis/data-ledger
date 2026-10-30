import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, reimbursements, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { candidates } from "@/lib/manual/match";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { manualMatches } from "@/operations/manual";
import { execute, read, undoCommand } from "@/operations/runtime";
import { getTransaction, listInbox, spendingLines } from "@/operations/transactions";

// Transactions added by hand (#64), on the synthetic seed (which ends
// 2026-06-30). Invented merchants, people and amounts only.

let db: Db;
let p2p: string;
let checking: string;
let cat: Record<string, string>;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
  [{ id: checking }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "checking"));
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
});

type Out = { status: string; commandId: string; output: unknown };
const run = (operation: string, input: Record<string, unknown>, actor: "user" | "tally" | "import" = "user") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<Out>;
const add = async (input: Record<string, unknown> = {}) => {
  const result = await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -4_250, description: "Dinner with Alex", ...input });
  return { ...result, id: (result.output as { transactionId: string }).transactionId };
};
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const lineFor = async (id: string) => (await read(db, spendingLines, { from: "2026-06-01", to: "2026-06-30" })).filter((l) => l.transactionId === id);
/** What the sync would bring in later: the bank's own row for the purchase. */
const bankRow = async (postedOn: string, amountCents: number, description = "PAYPEER *LUMEN BISTRO") =>
  (await db.insert(transactions).values({ accountId: p2p, postedOn, amountCents, description, merchant: "Lumen Bistro", externalId: `bank-${postedOn}-${amountCents}` }).returning())[0];

describe("the matching rule", () => {
  const manual = { id: "m", accountId: "a", amountCents: -4_250, postedOn: "2026-06-20", merchant: "Lumen Bistro" };
  it("takes the same account and amount within the window, the same merchant first, then the closest date", () => {
    const bank = [
      { id: "far", accountId: "a", amountCents: -4_250, postedOn: "2026-06-28", merchant: null }, // 8 days on: too far
      { id: "early", accountId: "a", amountCents: -4_250, postedOn: "2026-06-16", merchant: null }, // 4 days before: too far
      { id: "cent", accountId: "a", amountCents: -4_251, postedOn: "2026-06-21", merchant: null },
      { id: "other", accountId: "b", amountCents: -4_250, postedOn: "2026-06-21", merchant: null },
      { id: "near", accountId: "a", amountCents: -4_250, postedOn: "2026-06-21", merchant: null },
      { id: "same", accountId: "a", amountCents: -4_250, postedOn: "2026-06-25", merchant: "Lumen Bistro" },
    ];
    expect(candidates(manual, bank).map((b) => b.id)).toEqual(["same", "near"]);
  });
});

describe("adding, changing and deleting", () => {
  it("adds one as manual, in the inbox, counting once categorized; each change is undoable", async () => {
    const added = await add();
    expect(await row(added.id)).toMatchObject({ source: "manual", amountCents: -4_250, merchant: expect.any(String), categoryId: null });
    expect((await read(db, getTransaction, { transactionId: added.id })).manual).toBe(true);
    expect((await read(db, listInbox, { limit: 500 })).find((r) => r.id === added.id)?.manual).toBe(true);

    await run("transactions.setCategory", { transactionId: added.id, categoryId: cat.Dining });
    expect(await lineFor(added.id)).toEqual([expect.objectContaining({ amountCents: -4_250, categoryId: cat.Dining })]);

    const edit = await run("transactions.updateManual", { transactionId: added.id, amountCents: -4_500, description: "Dinner with Sam" });
    expect(await row(added.id)).toMatchObject({ amountCents: -4_500, description: "Dinner with Sam" });
    await undoCommand(db, edit.commandId);
    expect(await row(added.id)).toMatchObject({ amountCents: -4_250, description: "Dinner with Alex" });

    await run("transactions.setTags", { transactionId: added.id, tags: ["trip"] });
    const removed = await run("transactions.deleteManual", { transactionId: added.id });
    expect(await row(added.id)).toBeUndefined();
    await undoCommand(db, removed.commandId);
    expect(await row(added.id)).toMatchObject({ categoryId: cat.Dining });
    expect(await db.select().from(transactionTags).where(eq(transactionTags.transactionId, added.id))).toHaveLength(1);
  });

  it("refuses zero, the future, manual and investment accounts, and changing or deleting the bank's", async () => {
    await expect(add({ amountCents: 0 })).rejects.toThrow(/amount/);
    await expect(add({ postedOn: "2999-01-01" })).rejects.toThrow(/future/);
    await expect(add({ amountCents: -42.5 })).rejects.toThrow();
    const [brokerage] = await db.select().from(accounts).where(eq(accounts.type, "brokerage"));
    await expect(add({ accountId: brokerage.id })).rejects.toThrow(/Investment/);
    const house = await run("accounts.createManual", { name: "Example House", kind: "other_asset", valueCents: 1_000_00, on: "2026-06-01" });
    await expect(add({ accountId: (house.output as { id: string }).id })).rejects.toThrow(/balance only/);
    const [bank] = await db.select().from(transactions).where(eq(transactions.accountId, checking)).limit(1);
    await expect(run("transactions.updateManual", { transactionId: bank.id, description: "x" })).rejects.toThrow(/by hand/);
    await expect(run("transactions.deleteManual", { transactionId: bank.id })).rejects.toThrow(/by hand/);
    await expect(run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -100, description: "x" }, "import")).rejects.toThrow(/may not run/);
  });

  it("splits and shares like any other, and won't change the amount under them", async () => {
    const added = await add({ categoryId: cat.Dining });
    await run("transactions.split", {
      transactionId: added.id,
      parts: [
        { amountCents: -3_000, categoryId: cat.Dining, note: null },
        { amountCents: -1_250, categoryId: cat.Coffee, note: null },
      ],
    });
    await expect(run("transactions.updateManual", { transactionId: added.id, amountCents: -5_000 })).rejects.toThrow(/split/);
    expect((await lineFor(added.id)).map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-3_000, -1_250]);
  });
});

describe("when the bank reports it too", () => {
  it("counts only the bank's while it waits, and asks rather than merging", async () => {
    const added = await add({ categoryId: cat.Dining });
    const bank = await bankRow("2026-06-22", -4_250);
    expect(await lineFor(added.id)).toEqual([]);
    const matches = await read(db, manualMatches, {});
    expect(matches).toEqual([expect.objectContaining({ id: added.id, candidates: [expect.objectContaining({ id: bank.id })] })]);
    expect(await row(added.id)).toBeDefined();
  });

  it("merges: the owner's category, tags and shares move to the bank's row, and undo brings it back", async () => {
    const added = await add({ categoryId: cat.Dining });
    await run("transactions.setTags", { transactionId: added.id, tags: ["trip"] });
    const alex = (await run("people.create", { name: "Alex Example" })).output as { id: string };
    await run("reimbursements.setShares", { transactionId: added.id, shares: [{ personId: alex.id, amountCents: 2_000 }] });
    const bank = await bankRow("2026-06-22", -4_250);

    const merged = await run("transactions.mergeManual", { manualId: added.id, transactionId: bank.id });
    expect(await row(added.id)).toBeUndefined();
    expect(await row(bank.id)).toMatchObject({ categoryId: cat.Dining });
    expect(await db.select().from(transactionTags).where(eq(transactionTags.transactionId, bank.id))).toHaveLength(1);
    expect(await db.select().from(reimbursements).where(eq(reimbursements.transactionId, bank.id))).toHaveLength(1);
    // Counted once, net of what Alex owes.
    expect(await lineFor(bank.id)).toEqual([expect.objectContaining({ amountCents: -2_250 })]);
    expect(await read(db, manualMatches, {})).toEqual([]);

    await undoCommand(db, merged.commandId);
    expect(await row(added.id)).toMatchObject({ categoryId: cat.Dining });
    expect(await row(bank.id)).toMatchObject({ categoryId: null });
  });

  it("keeps both when they're different purchases: both count, and it isn't asked again", async () => {
    const added = await add({ categoryId: cat.Dining });
    const bank = await bankRow("2026-06-22", -4_250);
    await run("transactions.setCategory", { transactionId: bank.id, categoryId: cat.Dining });
    await run("transactions.keepManual", { transactionId: added.id });
    expect(await read(db, manualMatches, {})).toEqual([]);
    expect(await lineFor(added.id)).toHaveLength(1);
    expect(await lineFor(bank.id)).toHaveLength(1);
  });

  it("won't merge a different amount or into another manual one", async () => {
    const added = await add();
    const other = await add({ amountCents: -4_250, description: "Second dinner" });
    const bank = await bankRow("2026-06-22", -4_300);
    await expect(run("transactions.mergeManual", { manualId: added.id, transactionId: bank.id })).rejects.toThrow(/amounts differ/);
    await expect(run("transactions.mergeManual", { manualId: added.id, transactionId: other.id })).rejects.toThrow(/bank reported/);
  });
});
