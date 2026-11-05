import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, dailyPrices, holdingSnapshots, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { testDb } from "@/lib/test-utils/db";
import { draftTradeGaps } from "@/lib/trades/draft-gaps";
import { hintQuantities, suggestionsFor } from "@/lib/trades/suggest-load";
import { execute } from "@/operations/runtime";

// Suggestions on the Trades page (#323), from real rows: snapshots with cost
// basis, the price cache and cash rows. Invented brokerage, funds and amounts.

let db: Db;
let broker: string;

async function snapshot(on: string, shares: string, costBasisCents: number | null, externalId = "ZQXV", symbol: string | null = "ZQXV") {
  await db.insert(holdingSnapshots).values({ accountId: broker, on, externalId, symbol, description: "Example Growth Fund", shares, marketValueCents: Math.round(Number(shares) * 12_600), costBasisCents, currency: "USD" });
}
const draft = async () => (await db.select().from(trades).where(eq(trades.status, "draft")))[0];
const forDraft = async () => {
  const d = await draft();
  return (await suggestionsFor(db, [d])).get(d.id)!;
};

beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", countsTowardBudgets: false })
    .returning({ id: accounts.id });
});

describe("suggestions for a gap draft", () => {
  beforeEach(async () => {
    await snapshot("2026-05-01", "10", 100_000);
    await draftTradeGaps(db);
    await snapshot("2026-05-05", "12", 125_000);
    await draftTradeGaps(db);
    await db.insert(dailyPrices).values([
      { assetClass: "equity", symbol: "ZQXV", on: "2026-05-03", price: "121", source: "test" },
      { assetClass: "equity", symbol: "ZQXV", on: "2026-05-04", price: "125.1", source: "test" },
    ]);
  });

  it("offers a price from cost basis first, then the close, and the day that fits it", async () => {
    const { suggestions } = await forDraft();
    expect(suggestions.map((s) => [s.field, s.value])).toEqual([
      ["price", "125"],
      ["price", "125.1"],
      ["on", "2026-05-04"],
    ]);
  });

  it("saves nothing until one is used, and using one is one change", async () => {
    const before = await draft();
    await forDraft();
    expect(await draft()).toEqual(before);
    const { suggestions } = await forDraft();
    for (const s of suggestions.filter((x) => x.field !== "price" || x.value === "125"))
      await execute(db, { operation: "trades.update", input: { tradeId: before.id, ...(s.field === "on" ? { on: s.value, onFrom: null } : { [s.field]: s.value }) }, actor: "user", reason: "test" });
    expect(await draft()).toMatchObject({ price: "125", on: "2026-05-04", onFrom: null });
    // Nothing left to suggest.
    expect((await forDraft()).suggestions).toEqual([]);
  });
});

describe("with less to go on", () => {
  it("says there's no price when there's no cost basis, close or cash row", async () => {
    await snapshot("2026-05-01", "10", null);
    await draftTradeGaps(db);
    await snapshot("2026-05-05", "12", null);
    await draftTradeGaps(db);
    // The position's value still gives one; take it away to see the note.
    await db.update(holdingSnapshots).set({ shares: "12", marketValueCents: 0 }).where(eq(holdingSnapshots.on, "2026-05-05"));
    const { suggestions, notes } = await forDraft();
    expect(suggestions.filter((s) => s.field === "price")).toEqual([]);
    expect(notes[0]).toMatch(/No price/);
  });

  it("names a symbol-less draft from a cash row, and works out shares for a hint", async () => {
    await snapshot("2026-05-01", "3", null, "pos-77", null);
    await draftTradeGaps(db);
    await snapshot("2026-05-05", "5", null, "pos-77", null);
    await draftTradeGaps(db);
    const [row] = await db.insert(transactions).values({ accountId: broker, postedOn: "2026-05-04", amountCents: -25_000, description: "BUY ZQAB", externalId: "c1" }).returning();
    expect((await forDraft()).suggestions.filter((s) => s.field === "symbol").map((s) => s.value)).toEqual(["ZQAB"]);

    await db.insert(dailyPrices).values({ assetClass: "equity", symbol: "ZQAB", on: "2026-05-04", price: "125", source: "test" });
    const q = await hintQuantities(db, [{ id: row.id, postedOn: row.postedOn, amountCents: row.amountCents, symbol: "ZQAB", quantity: null }]);
    expect(q.get(row.id)).toMatchObject({ field: "quantity", value: "2" });
  });
});
