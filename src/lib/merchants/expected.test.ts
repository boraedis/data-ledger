import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, merchants, merchantTypes, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { merchantsOutOfScope } from "@/lib/merchants/expected";
import { suggestMerchantTypes } from "@/lib/merchants/suggest-types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { merchantOverviewRead } from "@/operations/merchant-views";
import { read } from "@/operations/runtime";
import { listTransactions, transactionTypeCounts } from "@/operations/transactions";

// Which rows need a merchant (#349), on the synthetic seed with invented
// merchants: a $0 row, a transfer and a brokerage row don't, so they're not
// tagged "No merchant" or "No type", and a merchant made only of them is
// off the Merchants page and out of type suggestions.

let db: Db;
let card: string;
let brokerage: string;
let transfers: string;
const ON = "2026-06-20";
const span = { from: ON, to: ON };

let n = 0;
async function row(accountId: string, cents: number, name: string, merchantId: string | null, categoryId: string | null = null) {
  const [r] = await db
    .insert(transactions)
    .values({ accountId, postedOn: ON, amountCents: cents, description: name.toUpperCase(), merchant: name, merchantId, categoryId, externalId: `exp-${++n}` })
    .returning();
  return r.id;
}
const merchant = async (name: string) => (await db.insert(merchants).values({ name }).returning())[0].id;
const ids = async (input: Record<string, unknown>) => (await read(db, listTransactions, { ...span, ...input })).map((t) => t.id);

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  // Only this test's merchants are without a type, and only its rows are on its day.
  const [anyType] = await db.select().from(merchantTypes).limit(1);
  await db.update(merchants).set({ typeId: anyType.id });
  await db.delete(transactions).where(eq(transactions.postedOn, ON));
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  [{ id: brokerage }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "brokerage")).limit(1);
  [{ id: transfers }] = await db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer")).limit(1);
});

describe("No merchant and No type", () => {
  it("skip $0 rows, transfers and brokerage rows, and count the same way", async () => {
    const needs = await row(card, -1_850, "Corner Bakery", null);
    await row(card, 0, "Card check", null);
    await row(card, -40_000, "Transfer to savings", null, transfers);
    await row(brokerage, -25_000, "Bought index fund", null);
    const untyped = await merchant("Example Kiosk");
    const kiosk = await row(card, -900, "Example Kiosk", untyped);
    await row(card, 0, "Example Kiosk", untyped);

    expect(await ids({ noMerchant: true })).toEqual([needs]);
    expect(await ids({ noMerchantType: true })).toEqual([kiosk]);
    expect(await read(db, transactionTypeCounts, span)).toMatchObject({ noMerchant: 1, noMerchantType: 1 });

    // The chip reads the same answer off each row.
    const listed = await read(db, listTransactions, span);
    expect(listed.filter((t) => t.merchantExpected).map((t) => t.id).sort()).toEqual([needs, kiosk].sort());
  });
});

describe("the Merchants page", () => {
  it("leaves out a merchant made only of rows that need none, and counts only the rows that do", async () => {
    const fund = await merchant("Example Brokerage Sweep");
    await row(brokerage, -5_000, "Example Brokerage Sweep", fund);
    const move = await merchant("Example Savings Transfer");
    await row(card, -10_000, "Example Savings Transfer", move, transfers);
    const mixed = await merchant("Example Diner");
    await row(card, -2_400, "Example Diner", mixed);
    await row(card, 0, "Example Diner", mixed);
    const fresh = await merchant("Example New Shop");

    // The seed has its own (its transfers and brokerage rows); these two join them.
    const out = await merchantsOutOfScope(db);
    expect([fund, move].every((id) => out.has(id))).toBe(true);
    expect(out.has(mixed) || out.has(fresh)).toBe(false);
    const overview = await read(db, merchantOverviewRead, {});
    const shown = new Map(overview.map((m) => [m.id, m]));
    expect(shown.has(fund)).toBe(false);
    expect(shown.has(move)).toBe(false);
    expect(shown.get(mixed)?.transactions).toBe(1);
    // No rows yet: still listed, since it may be about to get some.
    expect(shown.has(fresh)).toBe(true);

    // And no type is suggested for the ones left out.
    const asked: string[][] = [];
    await suggestMerchantTypes(db, { ask: async (_types, names) => (asked.push(names), names.map(() => ({ typeId: null, confidence: 0 }))) });
    expect(asked.flat()).not.toContain("Example Brokerage Sweep");
    expect(asked.flat()).not.toContain("Example Savings Transfer");
    expect(asked.flat()).toContain("Example Diner");
  });
});
