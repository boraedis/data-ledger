import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts } from "@/db/schema";
import type { Db } from "@/db/types";
import { merchantReview, merchantReviewCounts } from "@/lib/merchants/review";
import { applySeed } from "@/lib/seed/apply";
import { gatherFacts } from "@/lib/tally/digest";
import { summaryView } from "@/lib/tally/summary";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// Merchant suggestions where the owner triages (#303), on the synthetic
// seed with invented merchants: what the Inbox shows, and the nightly
// summary's count of it.

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  const [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
  // The seed has "Corner Bean Cafe"; this makes it a pair.
  await execute(db, { operation: "transactions.createManual", input: { accountId: p2p, postedOn: "2026-06-20", amountCents: -500, description: "Corner Bean" }, actor: "user", reason: "test" });
});

const corner = (r: Awaited<ReturnType<typeof merchantReview>>) => r.pairs.find((p) => [p.a.name, p.b.name].includes("Corner Bean"));

describe("merchant review", () => {
  it("gives a few pairs with their evidence, and the total for 'see all'", async () => {
    const r = await merchantReview(db, { pairs: 1 });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairTotal).toBeGreaterThanOrEqual(1);
    const all = await merchantReview(db, { pairs: 100 });
    const pair = corner(all)!;
    expect(pair.a.transactions + pair.b.transactions).toBeGreaterThan(0);
    expect(pair.a.descriptions.length).toBeGreaterThan(0);
  });

  it("leaves out pairs made only of brokerage rows, which have no merchant by nature (#349)", async () => {
    const [{ id: broker }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "brokerage"));
    const [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
    const add = (accountId: string, description: string) =>
      execute(db, { operation: "transactions.createManual", input: { accountId, postedOn: "2026-06-21", amountCents: 1_200, description }, actor: "user", reason: "test" });
    // Two spellings of one fund's dividend, in the brokerage: not a business to merge.
    await add(broker, "Dividend Harbor Fund");
    await add(broker, "Dividend Harbor Fund Payout");
    // The same shape of pair in a payment app is a real suggestion.
    await add(p2p, "Lumen Market");
    await add(p2p, "Lumen Market Downtown");
    const r = await merchantReview(db, { pairs: 1000 });
    const names = r.pairs.flatMap((p) => [p.a.name, p.b.name]);
    expect(names).toContain("Lumen Market Downtown");
    expect(names.some((n) => n.startsWith("Dividend Harbor"))).toBe(false);
  });

  it("is counted the same by the nightly summary, and a rejected pair leaves both; undo brings it back", async () => {
    const before = await merchantReview(db, { pairs: 100 });
    const facts = await gatherFacts(db, "2026-06-30");
    expect(facts.merchants).toEqual({ duplicates: before.pairTotal, types: before.types.length });
    const view = summaryView("All quiet.", facts);
    expect(view.chips.map((c) => c.label)).toContain(`${before.pairTotal} merchant${before.pairTotal === 1 ? "" : "s"} look${before.pairTotal === 1 ? "s" : ""} duplicated`);

    const pair = corner(before)!;
    const rejected = await execute(db, { operation: "merchants.dismissMerge", input: { merchantId: pair.a.id, otherId: pair.b.id }, actor: "user", reason: "test" });
    expect(corner(await merchantReview(db, { pairs: 100 }))).toBeUndefined();
    expect((await merchantReviewCounts(db)).duplicates).toBe(before.pairTotal - 1);
    await undoCommand(db, (rejected as { commandId: string }).commandId);
    expect(corner(await merchantReview(db, { pairs: 100 }))).toBeDefined();
  });

  it("puts nothing in the summary when nothing waits", () => {
    const view = summaryView("All quiet.", { inbox: 0, merchants: { duplicates: 0, types: 0 } });
    expect(view.chips.some((c) => /duplicated|to approve/.test(c.label))).toBe(false);
    expect(view.tone).toBe("calm");
  });
});
