import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// On the synthetic seed, which has shared dinners on the card followed by
// invented friends paying their share back over the payment app (#8).

let db: Db;
let p2pId: string;
let dining: string;
const ids: Record<string, string> = {};

type Proposal = { transactionId: string; personName: string; kind: string; allocations: { reimbursementId: string; amountCents: number }[] };
type Line = { transactionId: string; amountCents: number };

const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;
const out = async <T,>(operation: string, input: Record<string, unknown> = {}) => (await run(operation, input)).output as T;

/** The first seed dinner with at least two friends paying back, and those payments. */
async function sharedDinner() {
  const dinners = await db
    .select()
    .from(transactions)
    .where(like(transactions.description, "TRATTORIA VERDE%"))
    .orderBy(transactions.postedOn);
  const payments = await db.select().from(transactions).where(and(eq(transactions.accountId, p2pId), like(transactions.description, "PAYPEER PAYMENT FROM%")));
  for (const dinner of dinners) {
    const theirs = payments.filter((p) => {
      const gap = (Date.parse(p.postedOn) - Date.parse(dinner.postedOn)) / 86_400_000;
      return gap >= 0 && gap <= 4 && Math.abs(p.amountCents - Math.round(-dinner.amountCents / 2)) < -dinner.amountCents;
    });
    const share = theirs[0]?.amountCents;
    const same = theirs.filter((p) => p.amountCents === share);
    if (same.length >= 1) return { dinner, payments: same };
  }
  throw new Error("seed has no shared dinner");
}

const personFor = (description: string) => {
  const name = description.replace("PAYPEER PAYMENT FROM ", "");
  return ids[name];
};

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2pId }] = await db.select().from(accounts).where(eq(accounts.type, "payment_app"));
  [{ id: dining }] = await db.select().from(categories).where(eq(categories.name, "Dining"));
  for (const name of ["ALEX RIVERA", "SAM OKAFOR", "PRIYA NANDAKUMAR", "JORDAN BELLWEATHER"]) {
    const person = await out<{ id: string }>("people.create", { name: name.replace(/\b(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase()) });
    ids[name] = person.id;
  }
});

describe("shared expenses", () => {
  it("counts only the owner's share, proposes the friends' payments, and keeps matched payments out of income and the inbox", async () => {
    const { dinner, payments } = await sharedDinner();
    await db.update(transactions).set({ categoryId: dining }).where(eq(transactions.id, dinner.id));
    const owed = payments.reduce((s, p) => s + p.amountCents, 0);
    const result = await out<{ yourShareCents: number }>("reimbursements.setShares", {
      transactionId: dinner.id,
      shares: payments.map((p) => ({ personId: personFor(p.description), amountCents: p.amountCents })),
    });
    expect(result.yourShareCents).toBe(-dinner.amountCents - owed);

    // Net spend: only the owner's share, right away.
    const net = await out<Line[]>("transactions.spendingLines", {});
    expect(net.find((l) => l.transactionId === dinner.id)?.amountCents).toBe(dinner.amountCents + owed);
    const gross = await out<Line[]>("transactions.spendingLines", { gross: true });
    expect(gross.find((l) => l.transactionId === dinner.id)?.amountCents).toBe(dinner.amountCents);

    // Each friend's payment is proposed as an exact match.
    const proposals = await out<Proposal[]>("reimbursements.proposals", { on: "2026-06-30" });
    for (const p of payments) {
      const proposal = proposals.find((x) => x.transactionId === p.id)!;
      expect(proposal).toMatchObject({ kind: "exact" });
      await run("reimbursements.match", { transactionId: p.id, allocations: proposal.allocations });
    }

    const inbox = await out<{ id: string }[]>("transactions.inbox", { limit: 500 });
    for (const p of payments) expect(inbox.some((i) => i.id === p.id)).toBe(false);
    const owedNow = await out<{ items: { transactionId: string }[] }>("reimbursements.owed", { on: "2026-06-30" });
    expect(owedNow.items.some((i) => i.transactionId === dinner.id)).toBe(false);
    // Even if a payment had been categorized as income, its matched part isn't.
    const [income] = await db.insert(categories).values({ name: "Gifts received", kind: "income" }).returning();
    await db.update(transactions).set({ categoryId: income.id }).where(eq(transactions.id, payments[0].id));
    expect((await out<Line[]>("transactions.spendingLines", {})).some((l) => l.transactionId === payments[0].id)).toBe(false);
  });

  it("handles one payment covering two expenses, and a partial payment", async () => {
    const [d1, d2] = await db.select().from(transactions).where(like(transactions.description, "QUILLFIELD%")).orderBy(transactions.postedOn).limit(2);
    const alex = ids["ALEX RIVERA"];
    await run("reimbursements.setShares", { transactionId: d1.id, shares: [{ personId: alex, amountCents: 2_000 }] });
    await run("reimbursements.setShares", { transactionId: d2.id, shares: [{ personId: alex, amountCents: 3_000 }] });
    const [both, part] = await db
      .insert(transactions)
      .values([
        { accountId: p2pId, externalId: "test-1", postedOn: d2.postedOn, amountCents: 5_000, description: "PAYPEER PAYMENT FROM ALEX RIVERA" },
        { accountId: p2pId, externalId: "test-2", postedOn: d2.postedOn, amountCents: 1_000, description: "PAYPEER PAYMENT FROM ALEX RIVERA" },
      ])
      .returning();

    let proposals = await out<Proposal[]>("reimbursements.proposals", { on: "2026-06-30" });
    const combined = proposals.find((p) => p.transactionId === both.id)!;
    expect(combined.kind).toBe("combined");
    expect(combined.allocations.map((a) => a.amountCents).sort()).toEqual([2_000, 3_000]);
    await run("reimbursements.match", { transactionId: both.id, allocations: combined.allocations });

    // Nothing left open for Alex: the smaller payment has nothing to match.
    proposals = await out<Proposal[]>("reimbursements.proposals", { on: "2026-06-30" });
    expect(proposals.some((p) => p.transactionId === part.id)).toBe(false);

    // Undo, then pay in parts.
    const { commandId } = await run("reimbursements.unmatch", { transactionId: both.id });
    expect(commandId).toBeTruthy();
    const [r1] = (await out<{ shares: { id: string }[] }>("reimbursements.forTransaction", { transactionId: d1.id })).shares;
    await run("reimbursements.match", { transactionId: part.id, allocations: [{ reimbursementId: r1.id, amountCents: 1_000 }] });
    const owed = await out<{ items: { reimbursementId: string; receivedCents: number; remainingCents: number }[] }>("reimbursements.owed", { on: "2026-06-30" });
    expect(owed.items.find((i) => i.reimbursementId === r1.id)).toMatchObject({ receivedCents: 1_000, remainingCents: 1_000 });
    await expect(run("reimbursements.match", { transactionId: part.id, allocations: [{ reimbursementId: r1.id, amountCents: 1 }] })).rejects.toThrow(/more than the payment/);
  });

  it("ages what's owed by person, and forgiving puts the unpaid part back into the owner's spend", async () => {
    const [d1] = await db.select().from(transactions).where(like(transactions.description, "QUILLFIELD%")).orderBy(transactions.postedOn).limit(1);
    await db.update(transactions).set({ categoryId: dining }).where(eq(transactions.id, d1.id));
    const sam = ids["SAM OKAFOR"];
    await run("reimbursements.setShares", { transactionId: d1.id, shares: [{ personId: sam, amountCents: 1_500 }] });
    const owed = await out<{ totalCents: number; people: { personName: string; buckets: number[]; oldestDays: number }[]; items: { reimbursementId: string }[] }>(
      "reimbursements.owed",
      { on: "2026-06-30" },
    );
    expect(owed.totalCents).toBe(1_500);
    expect(owed.people[0]).toMatchObject({ personName: "Sam Okafor" });
    expect(owed.people[0].buckets).toEqual([0, 0, 0, 1_500]); // the seed's oldest grocery run is months back

    await run("reimbursements.forgive", { reimbursementId: owed.items[0].reimbursementId });
    const line = (await out<Line[]>("transactions.spendingLines", {})).find((l) => l.transactionId === d1.id)!;
    expect(line.amountCents).toBe(d1.amountCents);
    expect((await out<{ totalCents: number }>("reimbursements.owed", { on: "2026-06-30" })).totalCents).toBe(0);
  });

  it("guards shares: no more than the expense, not below what's been paid, not on money in", async () => {
    const { dinner, payments } = await sharedDinner();
    const person = personFor(payments[0].description);
    await expect(run("reimbursements.setShares", { transactionId: dinner.id, shares: [{ personId: person, amountCents: -dinner.amountCents + 1 }] })).rejects.toThrow(/more than the whole/);
    await expect(run("reimbursements.setShares", { transactionId: payments[0].id, shares: [{ personId: person, amountCents: 1 }] })).rejects.toThrow(/money spent/);

    await run("reimbursements.setShares", { transactionId: dinner.id, shares: [{ personId: person, amountCents: payments[0].amountCents }] });
    const [share] = (await out<{ shares: { id: string }[] }>("reimbursements.forTransaction", { transactionId: dinner.id })).shares;
    const matched = await run("reimbursements.match", { transactionId: payments[0].id, allocations: [{ reimbursementId: share.id, amountCents: payments[0].amountCents }] });
    await expect(run("reimbursements.setShares", { transactionId: dinner.id, shares: [] })).rejects.toThrow(/already paid back/);
    // Undoing the match makes un-sharing possible again.
    await undoCommand(db, matched.commandId);
    await run("reimbursements.setShares", { transactionId: dinner.id, shares: [] });
    expect((await out<{ shares: unknown[] }>("reimbursements.forTransaction", { transactionId: dinner.id })).shares).toHaveLength(0);
  });

  it("stops proposing a payment the owner dismisses", async () => {
    const { dinner, payments } = await sharedDinner();
    await run("reimbursements.setShares", { transactionId: dinner.id, shares: [{ personId: personFor(payments[0].description), amountCents: payments[0].amountCents }] });
    expect((await out<Proposal[]>("reimbursements.proposals", { on: "2026-06-30" })).some((p) => p.transactionId === payments[0].id)).toBe(true);
    await run("reimbursements.dismiss", { transactionId: payments[0].id });
    expect((await out<Proposal[]>("reimbursements.proposals", { on: "2026-06-30" })).some((p) => p.transactionId === payments[0].id)).toBe(false);
  });

  it("budgets count the owner's share, with gross on demand", async () => {
    const { dinner, payments } = await sharedDinner();
    await db.update(transactions).set({ categoryId: dining }).where(eq(transactions.id, dinner.id));
    const owed = payments.reduce((s, p) => s + p.amountCents, 0);
    await run("reimbursements.setShares", {
      transactionId: dinner.id,
      shares: payments.map((p) => ({ personId: personFor(p.description), amountCents: p.amountCents })),
    });
    await run("budgets.setTarget", { categoryId: dining, amountCents: 100_000, today: dinner.postedOn });
    type S = { targets: { categoryId: string; spentCents: number }[] };
    const net = await out<S>("budgets.status", { on: dinner.postedOn });
    const gross = await out<S>("budgets.status", { on: dinner.postedOn, gross: true });
    const spent = (s: S) => s.targets.find((t) => t.categoryId === dining)!.spentCents;
    expect(spent(gross) - spent(net)).toBe(owed);
  });
});
