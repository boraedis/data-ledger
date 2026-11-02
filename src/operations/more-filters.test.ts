import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, tags, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { read } from "@/operations/runtime";
import { listTransactions, transactionTypeCounts, type TransactionFilter } from "@/operations/transactions";

// The More filters panel's filters (#211), on the synthetic seed. Merchants,
// amounts and dates are invented; each test adds its rows in a stretch of
// July the seed (ending 2026-06-30) never reaches.

let db: Db;
let acct: Record<string, string>;
const ids = async (filter: TransactionFilter) =>
  (await read(db, listTransactions, { from: "2026-07-01", to: "2026-07-31", ...filter, limit: 500 })).map((r) => r.id).sort();

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  acct = Object.fromEntries((await db.select().from(accounts)).map((a) => [a.name, a.id]));
});

let n = 0;
async function add(account: string, postedOn: string, amountCents: number, extra: Partial<typeof transactions.$inferInsert> = {}) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: acct[account], postedOn, amountCents, description: `ROW ${++n}`, merchant: `Row ${n}`, externalId: `more-${n}`, ...extra })
    .returning();
  return row;
}
async function pair(outAccount: string, inAccount: string, postedOn: string, cents: number) {
  const out = await add(outAccount, postedOn, -cents);
  const inn = await add(inAccount, postedOn, cents, { transferPairId: out.id });
  await db.update(transactions).set({ transferPairId: inn.id }).where(eq(transactions.id, out.id));
  return { out: out.id, in: inn.id };
}

describe("More filters (#211)", () => {
  it("a date range and an amount range together show only charges in both", async () => {
    const inBoth = await add("Rewards Card", "2026-07-10", -4250);
    const tooBig = await add("Rewards Card", "2026-07-10", -9000);
    const tooEarly = await add("Rewards Card", "2026-07-02", -4250);
    const refund = await add("Rewards Card", "2026-07-12", 3000);
    const filter = { from: "2026-07-05", to: "2026-07-15", amountMinCents: 2000, amountMaxCents: 5000 };
    expect(await ids(filter)).toEqual([inBoth.id, refund.id].sort());
    // Signed, money out is negative: -$50 to -$20 is charges only.
    expect(await ids({ ...filter, amountMinCents: -5000, amountMaxCents: -2000, amountSigned: true })).toEqual([inBoth.id]);
    expect([tooBig.id, tooEarly.id].some((id) => [inBoth.id, refund.id].includes(id))).toBe(false);
  });

  it("transfers with one account list only transfers with that account on the other side", async () => {
    const toSavings = await pair("Everyday Checking", "Rainy Day Savings", "2026-07-03", 50_000);
    const toCard = await pair("Everyday Checking", "Rewards Card", "2026-07-04", 20_000);
    await add("Everyday Checking", "2026-07-05", -50_000);
    expect(await ids({ transferAccountId: acct["Rainy Day Savings"] })).toEqual([toSavings.out]);
    expect(await ids({ transferAccountId: acct["Everyday Checking"] })).toEqual([toSavings.in, toCard.in].sort());
  });

  it("has tags, split, pending and source each narrow to their rows, and combine", async () => {
    const tagged = await add("Rewards Card", "2026-07-06", -1500);
    const [tag] = await db.insert(tags).values({ name: "trip" }).returning();
    await db.insert(transactionTags).values({ transactionId: tagged.id, tagId: tag.id });
    const split = await add("Rewards Card", "2026-07-06", -2500, { isSplit: true });
    const pending = await add("Rewards Card", "2026-07-06", -3500, { pending: true });
    const manual = await add("Rewards Card", "2026-07-06", -4500, { source: "manual" });
    const alert = await add("Rewards Card", "2026-07-06", -5500, { provisionalSource: "apple_pay" });

    expect(await ids({ hasTags: true })).toEqual([tagged.id]);
    expect(await ids({ split: true })).toEqual([split.id]);
    expect(await ids({ pending: true })).toEqual([pending.id]);
    expect(await ids({ source: "manual" })).toEqual([manual.id]);
    expect(await ids({ source: "provisional" })).toEqual([alert.id]);
    expect(await ids({ source: "bank" })).toEqual([tagged.id, split.id, pending.id].sort());
    expect(await ids({ source: "bank", pending: true })).toEqual([pending.id]);
  });

  it("applies to the type filter's counts too", async () => {
    await add("Rewards Card", "2026-07-06", -1500);
    await add("Rewards Card", "2026-07-06", -9000);
    const filter = { from: "2026-07-01", to: "2026-07-31", amountMaxCents: 2000 };
    expect((await read(db, transactionTypeCounts, filter)).uncategorized).toBe((await ids({ ...filter, uncategorized: true })).length);
    expect((await read(db, transactionTypeCounts, filter)).uncategorized).toBe(1);
  });
});
