import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { read } from "@/operations/runtime";
import { listTransactions } from "@/operations/transactions";

// Searching the Transactions list by date and amount (#213), on the
// synthetic seed. Merchants and amounts are invented.

let db: Db;
let card: string;
const ids = async (search: string) => (await read(db, listTransactions, { search, limit: 500 })).map((r) => r.id);

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
});

let n = 0;
async function add(postedOn: string, amountCents: number, merchant: string, extra: Partial<typeof transactions.$inferInsert> = {}) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: card, postedOn, amountCents, description: merchant.toUpperCase(), merchant, externalId: `search-${++n}`, ...extra })
    .returning();
  return row;
}

describe("search (#213)", () => {
  it("finds a charge by its amount, and by its date", async () => {
    const lamp = await add("2026-06-19", -4250, "Brightwick Lamps");
    expect(await ids("42.50")).toContain(lamp.id);
    expect(await ids("$42.50")).toContain(lamp.id);
    expect(await ids("2026-06-19")).toContain(lamp.id);
    expect(await ids("6/19/2026")).toContain(lamp.id);
    expect(await ids("42.51")).not.toContain(lamp.id);
  });

  it("matches a signed amount in that direction only", async () => {
    const charge = await add("2026-06-19", -4250, "Brightwick Lamps");
    const refund = await add("2026-06-20", 4250, "Brightwick Lamps");
    expect(await ids("42.50")).toEqual(expect.arrayContaining([charge.id, refund.id]));
    const out = await ids("-42.50");
    expect(out).toContain(charge.id);
    expect(out).not.toContain(refund.id);
    expect(await ids("+42.50")).not.toContain(charge.id);
  });

  it("matches the date it was for, as the row shows it", async () => {
    const dinner = await add("2026-06-22", -6800, "Saltmarsh Bistro", { experiencedOn: "2026-06-18" });
    expect(await ids("2026-06-18")).toContain(dinner.id);
  });

  it("still matches merchant and description text, and only that, for plain text", async () => {
    const lamp = await add("2026-06-19", -4250, "Brightwick Lamps");
    expect(await ids("brightwick")).toEqual([lamp.id]);
    expect(await ids("BRIGHTWICK LAMPS")).toEqual([lamp.id]);
  });

  it("keeps matching a number in the text, alongside the amount", async () => {
    const store = await add("2026-06-19", -1599, "Depot 42");
    const lamp = await add("2026-06-19", -4200, "Brightwick Lamps");
    expect(await ids("42")).toEqual(expect.arrayContaining([store.id, lamp.id]));
  });
});
