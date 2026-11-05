import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, commandLog, holdingSnapshots, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { testDb } from "@/lib/test-utils/db";
import { draftTradeGaps } from "@/lib/trades/draft-gaps";
import { execute, undoCommand } from "@/operations/runtime";

// Drafting trades from gaps between what the sync reports and what the trade
// log replays to (#320). Invented brokerage, funds and quantities.

let db: Db;
let broker: string;

const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, input, actor: "user", reason: "test" });

async function snapshot(on: string, positions: { id: string; symbol?: string | null; shares: string; valueCents?: number; description?: string }[]) {
  await db.insert(holdingSnapshots).values(
    positions.map((p) => ({
      accountId: broker,
      on,
      externalId: p.id,
      symbol: p.symbol === undefined ? p.id : p.symbol,
      description: p.description ?? `${p.id} Example Fund`,
      shares: p.shares,
      // $125 a share unless said otherwise, so nothing looks like a $1.00 sweep fund.
      marketValueCents: p.valueCents ?? Math.round(Number(p.shares) * 12_500),
      currency: "USD",
    })),
  );
}

const all = () => db.select().from(trades).where(eq(trades.accountId, broker)).orderBy(trades.on, trades.createdAt);
const drafts = async () => (await all()).filter((t) => t.status === "draft");
const shape = (t: typeof trades.$inferSelect) => ({ symbol: t.symbol, positionId: t.positionId, side: t.side, quantity: t.quantity, onFrom: t.onFrom, on: t.on, source: t.source });
const commands = async () => (await db.select().from(commandLog).where(eq(commandLog.operation, "trades.draftGaps"))).length;

beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
    .returning({ id: accounts.id });
});

describe("the first run", () => {
  it("records what the account already holds as opening trades, and drafts nothing", async () => {
    await snapshot("2026-05-01", [{ id: "ZQXV", shares: "10" }, { id: "ZZIX", shares: "3.5" }]);
    expect(await draftTradeGaps(db)).toBe(0);
    expect((await all()).map((t) => [t.symbol, t.side, t.quantity, t.status, t.source, t.on])).toEqual([
      ["ZQXV", "buy", "10", "confirmed", "opening", "2026-05-01"],
      ["ZZIX", "buy", "3.5", "confirmed", "opening", "2026-05-01"],
    ]);
    const [{ tradesBaselineOn }] = await db.select().from(accounts).where(eq(accounts.id, broker));
    expect(tradesBaselineOn).toBe("2026-05-01");
  });

  it("counts trades already logged by hand, and opens only what they don't explain", async () => {
    await run("trades.add", { accountId: broker, on: "2026-03-01", symbol: "ZQXV", side: "buy", quantity: "4" });
    await snapshot("2026-05-01", [{ id: "ZQXV", shares: "10" }]);
    await draftTradeGaps(db);
    expect((await all()).map((t) => [t.side, t.quantity, t.source])).toEqual([
      ["buy", "4", "hand"],
      ["buy", "6", "opening"],
    ]);
  });

  it("waits for an account's first snapshot", async () => {
    expect(await draftTradeGaps(db)).toBe(0);
    expect(await commands()).toBe(0);
  });
});

describe("after the baseline", () => {
  beforeEach(async () => {
    await snapshot("2026-05-01", [{ id: "ZQXV", shares: "10" }, { id: "ZZOLD", shares: "4" }]);
    await draftTradeGaps(db);
  });

  it("drafts one buy for 10 → 12 shares, dated between the two snapshots", async () => {
    await snapshot("2026-05-03", [{ id: "ZQXV", shares: "12" }, { id: "ZZOLD", shares: "4" }]);
    expect(await draftTradeGaps(db)).toBe(1);
    expect((await drafts()).map(shape)).toEqual([{ symbol: "ZQXV", positionId: null, side: "buy", quantity: "2", onFrom: "2026-05-02", on: "2026-05-03", source: "position_gap" }]);
  });

  it("drafts a new position as a buy of all of it, and a vanished one as a sale of all of it", async () => {
    await snapshot("2026-05-02", [{ id: "ZQXV", shares: "10" }, { id: "ZZNEW", shares: "7" }]);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => [t.symbol, t.side, t.quantity, t.onFrom, t.on])).toEqual([
      ["ZZNEW", "buy", "7", null, "2026-05-02"],
      ["ZZOLD", "sell", "4", null, "2026-05-02"],
    ]);
  });

  it("does nothing on a second run, or once the draft is confirmed, and writes no empty command", async () => {
    await snapshot("2026-05-03", [{ id: "ZQXV", shares: "12" }, { id: "ZZOLD", shares: "4" }]);
    await draftTradeGaps(db);
    const before = await commands();
    expect(await draftTradeGaps(db)).toBe(0);
    const [draft] = await drafts();
    await run("trades.update", { tradeId: draft.id, onFrom: null, on: "2026-05-02" });
    await run("trades.confirm", { tradeId: draft.id });
    expect(await draftTradeGaps(db)).toBe(0);
    expect(await commands()).toBe(before);
  });

  it("leaves a dismissed gap dismissed, and never touches a trade the owner changed", async () => {
    await snapshot("2026-05-03", [{ id: "ZQXV", shares: "12" }, { id: "ZZOLD", shares: "4" }]);
    await draftTradeGaps(db);
    const [draft] = await drafts();
    await run("trades.dismiss", { tradeId: draft.id });
    await snapshot("2026-05-04", [{ id: "ZQXV", shares: "12" }, { id: "ZZOLD", shares: "4" }]);
    expect(await draftTradeGaps(db)).toBe(0);
    const [still] = (await all()).filter((t) => t.id === draft.id);
    expect(still).toMatchObject({ status: "dismissed", quantity: "2" });
  });

  it("drafts only what's left when the owner says a draft was smaller", async () => {
    await snapshot("2026-05-03", [{ id: "ZQXV", shares: "12" }, { id: "ZZOLD", shares: "4" }]);
    await draftTradeGaps(db);
    const [draft] = await drafts();
    await run("trades.update", { tradeId: draft.id, quantity: "1.5" });
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => [t.id === draft.id, t.quantity])).toEqual([
      [true, "1.5"],
      [false, "0.5"],
    ]);
  });

  it("keeps fractional shares exact", async () => {
    await snapshot("2026-05-02", [{ id: "ZQXV", shares: "10.25" }, { id: "ZZOLD", shares: "3.99999999" }]);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => [t.symbol, t.side, t.quantity])).toEqual([
      ["ZQXV", "buy", "0.25"],
      ["ZZOLD", "sell", "0.00000001"],
    ]);
  });

  it("dates a gap back to the last snapshot that agreed, and can be undone", async () => {
    // A sync where drafting didn't run: the gap is from the 2nd or the 3rd.
    await snapshot("2026-05-02", [{ id: "ZQXV", shares: "10" }, { id: "ZZOLD", shares: "4" }]);
    await snapshot("2026-05-03", [{ id: "ZQXV", shares: "11" }, { id: "ZZOLD", shares: "4" }]);
    await snapshot("2026-05-05", [{ id: "ZQXV", shares: "11" }, { id: "ZZOLD", shares: "4" }]);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => [t.onFrom, t.on])).toEqual([["2026-05-03", "2026-05-05"]]);

    const [{ id }] = await db.select({ id: commandLog.id }).from(commandLog).where(eq(commandLog.operation, "trades.draftGaps")).orderBy(commandLog.createdAt).offset(1);
    await undoCommand(db, id);
    expect(await drafts()).toEqual([]);
  });
});

describe("what isn't a holding, or has no symbol", () => {
  it("leaves cash and money-market funds out, however they move", async () => {
    await snapshot("2026-05-01", [
      { id: "ZQXV", shares: "10" },
      { id: "ZZMM", shares: "500", valueCents: 50_000, description: "Example Money Market Fund" },
      { id: "CORE", shares: "300", valueCents: 30_000, description: "Core holding" },
    ]);
    await draftTradeGaps(db);
    expect((await all()).map((t) => t.symbol)).toEqual(["ZQXV"]);
    // A buy of 2 at $125 comes out of cash.
    await snapshot("2026-05-02", [
      { id: "ZQXV", shares: "12" },
      { id: "ZZMM", shares: "250", valueCents: 25_000, description: "Example Money Market Fund" },
      { id: "CORE", shares: "300", valueCents: 30_000, description: "Core holding" },
    ]);
    await draftTradeGaps(db);
    expect((await drafts()).map((t) => t.symbol)).toEqual(["ZQXV"]);
  });

  it("drafts a position with no symbol by its id, and naming the draft doesn't make a new gap", async () => {
    await snapshot("2026-05-01", [{ id: "pos-77", symbol: null, shares: "3" }]);
    await draftTradeGaps(db);
    // Its opening can't be confirmed without a symbol: kept, but counted nowhere.
    expect((await all()).map((t) => [t.positionId, t.status, t.source])).toEqual([["pos-77", "dismissed", "opening"]]);

    await snapshot("2026-05-02", [{ id: "pos-77", symbol: null, shares: "5" }]);
    await draftTradeGaps(db);
    const [draft] = await drafts();
    expect(shape(draft)).toMatchObject({ symbol: null, positionId: "pos-77", side: "buy", quantity: "2" });

    await run("trades.update", { tradeId: draft.id, symbol: "ZQAB" });
    await run("trades.confirm", { tradeId: draft.id });
    await snapshot("2026-05-03", [{ id: "pos-77", symbol: null, shares: "5" }]);
    expect(await draftTradeGaps(db)).toBe(0);
  });
});
