import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, reimbursements, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { matchProvisionalStep } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listProvisional } from "@/operations/provisional";
import { execute, undoCommand } from "@/operations/runtime";
import { spendingLines } from "@/operations/transactions";

// Provisional transactions against the synthetic seed, which ends on
// 2026-06-30: an alert after that is a purchase the bank hasn't reported.

let db: Db;
let card: string;
let cat: Record<string, string>;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
});

async function alertFor(postedOn: string, amountCents: number, ref: string, description = "LUMEN BISTRO") {
  const result = await execute(db, {
    operation: "transactions.createProvisional",
    actor: "alert",
    reason: "Purchase alert",
    input: { accountId: card, postedOn, amountCents, description, source: "email", ref },
  });
  return result.status === "applied" ? (result.output as { status: string; transactionId: string }) : null;
}

/** What the sync would bring in: the bank's own row, arriving after the alert. */
async function bankRow(postedOn: string, amountCents: number) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: card, postedOn, amountCents, description: "LUMEN BISTRO 0042 SPRINGFIELD", merchant: "Lumen Bistro", externalId: `bank-${postedOn}-${amountCents}`, createdAt: new Date(Date.now() + 60_000) })
    .returning();
  return row;
}

const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, actor: "user", reason: "Test", input });
const july = (lines: { transactionId: string; amountCents: number }[]) => lines.filter((l) => l.amountCents < 0);

describe("creating", () => {
  it("records an alert once, and only from an alert source", async () => {
    const first = await alertFor("2026-07-02", -4210, "msg-1");
    expect(first?.status).toBe("created");
    expect(await alertFor("2026-07-02", -4210, "msg-1")).toEqual({ status: "duplicate", transactionId: first!.transactionId });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, first!.transactionId));
    expect(row).toMatchObject({ provisionalSource: "email", merchant: expect.any(String), externalId: "email:msg-1", categoryId: null });

    await expect(run("transactions.createProvisional", { accountId: card, postedOn: "2026-07-02", amountCents: -100, description: "X", source: "email", ref: "r" })).rejects.toThrow();
  });

  it("adds nothing when the bank already reported the purchase", async () => {
    const synced = await bankRow("2026-07-03", -4210);
    expect(await alertFor("2026-07-02", -4210, "msg-late")).toEqual({ status: "already_synced", transactionId: synced.id });
  });
});

describe("counting", () => {
  it("counts until the bank's data for the account reaches its date, never alongside the synced row", async () => {
    const p = await alertFor("2026-07-02", -4210, "msg-1");
    await run("transactions.setCategory", { transactionId: p!.transactionId, categoryId: cat.Dining });
    const lines = () => spendingLines.run(db, { from: "2026-07-01", to: "2026-07-31", budgetOnly: true, gross: false });
    expect(july(await lines())).toEqual([expect.objectContaining({ transactionId: p!.transactionId, amountCents: -4210 })]);

    // The bank reports it with a tip: no automatic match, but no double count either.
    const synced = await bankRow("2026-07-03", -5000);
    await run("transactions.setCategory", { transactionId: synced.id, categoryId: cat.Dining });
    expect(july(await lines()).map((l) => l.transactionId)).toEqual([synced.id]);
  });
});

describe("matching", () => {
  it("carries the owner's work to the synced row, removes the alert's row, and undoes cleanly", async () => {
    const p = (await alertFor("2026-07-02", -4210, "msg-1"))!.transactionId;
    await run("transactions.setCategory", { transactionId: p, categoryId: cat.Dining });
    await run("transactions.setTags", { transactionId: p, tags: ["date-night"] });
    const person = await run("people.create", { name: "Robin Example", aliases: [] });
    await run("reimbursements.setShares", { transactionId: p, shares: [{ personId: (person as { output: { id: string } }).output.id, amountCents: 2105 }] });

    const synced = await bankRow("2026-07-04", -4210);
    expect(await matchProvisionalStep(db)).toBe(1);

    expect(await db.select().from(transactions).where(eq(transactions.id, p))).toEqual([]);
    const [after] = await db.select().from(transactions).where(eq(transactions.id, synced.id));
    expect(after.categoryId).toBe(cat.Dining);
    expect(await db.select().from(transactionTags).where(eq(transactionTags.transactionId, synced.id))).toHaveLength(1);
    expect(await db.select().from(reimbursements).where(eq(reimbursements.transactionId, synced.id))).toHaveLength(1);
    expect(await matchProvisionalStep(db)).toBe(0);

    const [{ id: commandId }] = (await db.query.commandLog.findMany({ where: (c, { eq }) => eq(c.operation, "transactions.matchProvisional") }));
    await undoCommand(db, commandId);
    expect(await db.select().from(transactions).where(eq(transactions.id, p))).toHaveLength(1);
    expect((await db.select().from(transactions).where(eq(transactions.id, synced.id)))[0].categoryId).toBeNull();
    expect(await db.select().from(reimbursements).where(eq(reimbursements.transactionId, p))).toHaveLength(1);
  });

  it("keeps what's already set on the synced row", async () => {
    const p = (await alertFor("2026-07-02", -4210, "msg-1"))!.transactionId;
    await run("transactions.setCategory", { transactionId: p, categoryId: cat.Dining });
    const synced = await bankRow("2026-07-03", -4210);
    await run("transactions.setCategory", { transactionId: synced.id, categoryId: cat.Groceries });
    await run("transactions.matchProvisional", { pairs: [{ provisionalId: p, transactionId: synced.id }] });
    expect((await db.select().from(transactions).where(eq(transactions.id, synced.id)))[0].categoryId).toBe(cat.Groceries);
  });

  it("flags an unmatched alert after a week, offers candidates, and lets the owner match or discard it", async () => {
    const p = (await alertFor("2026-07-02", -4210, "msg-1"))!.transactionId;
    await run("transactions.setCategory", { transactionId: p, categoryId: cat.Dining });
    const tipped = await bankRow("2026-07-03", -5000);
    expect(await matchProvisionalStep(db)).toBe(0);

    const mine = async (on: string) => (await listProvisional.run(db, { on })).find((r) => r.id === p);
    const early = await mine("2026-07-05");
    expect(early).toMatchObject({ id: p, counting: false, stale: false });
    const late = (await mine("2026-07-12"))!;
    expect(late.stale).toBe(true);
    expect(late.candidates[0]).toMatchObject({ id: tipped.id, amountCents: -5000 });

    await run("transactions.matchProvisional", { pairs: [{ provisionalId: p, transactionId: tipped.id }] });
    expect((await db.select().from(transactions).where(eq(transactions.id, tipped.id)))[0].categoryId).toBe(cat.Dining);
    expect(await mine("2026-07-12")).toBeUndefined();

    const declined = (await alertFor("2026-07-06", -999, "msg-2"))!.transactionId;
    await run("transactions.discardProvisional", { transactionId: declined });
    expect(await db.select().from(transactions).where(eq(transactions.id, declined))).toEqual([]);
    await expect(run("transactions.discardProvisional", { transactionId: tipped.id })).rejects.toThrow(/Only a provisional/);
  });

  it("refuses matches that don't make sense", async () => {
    const p = (await alertFor("2026-07-02", -4210, "msg-1"))!.transactionId;
    const [checking] = await db.select().from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId)).where(eq(accounts.name, "Everyday Checking")).limit(1);
    await expect(run("transactions.matchProvisional", { pairs: [{ provisionalId: p, transactionId: checking.transactions.id }] })).rejects.toThrow(/same account/);
    const synced = await bankRow("2026-07-03", -4210);
    await expect(run("transactions.matchProvisional", { pairs: [{ provisionalId: synced.id, transactionId: p }] })).rejects.toThrow(/Only a provisional/);
  });
});

it("seeds one fresh alert that counts and one stale one with its tipped candidate", async () => {
  const rows = await listProvisional.run(db, { on: "2026-06-30" });
  expect(rows.map((r) => ({ on: r.postedOn, counting: r.counting, stale: r.stale }))).toEqual([
    { on: "2026-06-20", counting: false, stale: true },
    { on: "2026-06-30", counting: true, stale: false },
  ]);
  expect(rows[0].candidates[0]).toMatchObject({ amountCents: -5040, postedOn: "2026-06-21" });
});
