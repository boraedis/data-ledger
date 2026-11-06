import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { readCsv } from "@/lib/history/csv";
import { holdingsOn } from "@/lib/holdings/replay";
import { testDb } from "@/lib/test-utils/db";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { draftTradeGaps } from "@/lib/trades/draft-gaps";
import { applyBrokerageMapping, guessBrokerageMapping, type BrokerageRow } from "@/lib/trades/import-csv";
import { previewBrokerageImport } from "@/lib/trades/import-load";
import { moveBaseline } from "@/lib/trades/import-plan";
import { planTradeGaps } from "@/lib/trades/plan";

// What a brokerage import would do against what's already there (#355): an
// invented synced brokerage with a baseline, a draft from a gap, a synced
// cash row and a sweep fund, and an invented export reaching back before
// the baseline.

let db: Db;
let broker: string;

async function snapshot(on: string, positions: { symbol: string; shares: string; valueCents?: number; description?: string }[]) {
  await db.insert(holdingSnapshots).values(
    positions.map((p) => ({
      accountId: broker,
      on,
      externalId: p.symbol,
      symbol: p.symbol,
      description: p.description ?? `${p.symbol} Example Fund`,
      shares: p.shares,
      marketValueCents: p.valueCents ?? Math.round(Number(p.shares) * 12_500),
      currency: "USD",
    })),
  );
}

const FILE = `Date,Type,Ticker,Shares,Net Amount,Memo
2026-03-02,Buy,ZQXV,6,-600.00,
2026-04-10,Sell,ZQXV,1,100.00,
2026-04-15,Buy,ZZIX,5,-500.00,
2026-05-10,Buy,ZQXV,2,-250.00,
2026-05-12,Buy,ZMMF,100,-100.00,Sweep
2026-05-15,Dividend,ZZIX,,3.00,
`;
const fileRows = (): BrokerageRow[] => {
  const all = readCsv(FILE);
  const { rows, errors } = applyBrokerageMapping(all, guessBrokerageMapping(all));
  expect(errors).toEqual([]);
  return rows;
};
const confirmedHeld = async (day?: string) => holdingsOn(await confirmedTrades(db, eq(trades.accountId, broker)), day);

let draftId: string;
let synced: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
    .returning({ id: accounts.id });
  // The first sync: 10 ZQXV, 3.5 ZZIX and a $1.00 sweep fund, all openings on May 1.
  await snapshot("2026-05-01", [{ symbol: "ZQXV", shares: "10" }, { symbol: "ZZIX", shares: "3.5" }, { symbol: "ZMMF", shares: "500", valueCents: 50_000 }]);
  await draftTradeGaps(db);
  // Then 2 more ZQXV: a draft between May 2 and May 20, and its cash row from the sync a day after the trade.
  await snapshot("2026-05-20", [{ symbol: "ZQXV", shares: "12" }, { symbol: "ZZIX", shares: "3.5" }, { symbol: "ZMMF", shares: "500", valueCents: 50_000 }]);
  await draftTradeGaps(db);
  [{ id: draftId }] = await db.select({ id: trades.id }).from(trades).where(and(eq(trades.accountId, broker), eq(trades.status, "draft")));
  [{ id: synced }] = await db
    .insert(transactions)
    .values({ accountId: broker, postedOn: "2026-05-11", amountCents: -25_000, description: "YOU BOUGHT ZQXV", externalId: "sync-1" })
    .returning({ id: transactions.id });
});

describe("each row's plan", () => {
  it("fills the draft and links the synced cash row, keeps the sweep out, and adds the rest", async () => {
    const { rows } = await previewBrokerageImport(db, broker, fileRows());
    const at = (row: number) => rows.find((r) => r.row === row)!;
    expect(at(2)).toMatchObject({ tradePlan: { status: "new" }, cashPlan: { status: "new" }, linkTo: { kind: "new" }, ticked: true });
    // The draft's shares, its cash already synced: filled, and linked to the synced row.
    expect(at(5)).toMatchObject({ tradePlan: { status: "fills_draft", draftId }, cashPlan: { status: "already", existingId: synced }, linkTo: { kind: "existing", transactionId: synced }, ticked: true });
    // Shares of the account's own cash fund aren't a trade (#316).
    expect(at(6)).toMatchObject({ tradePlan: { status: "cash_fund" }, linkTo: null });
    expect(at(7)).toMatchObject({ category: "income", tradePlan: null, cashPlan: { status: "new" }, ticked: true });
  });

  it("flags a trade already confirmed, and a cash row another trade has, without linking to it", async () => {
    await db.insert(trades).values({ accountId: broker, on: "2026-04-11", symbol: "ZQXV", side: "sell", quantity: "1", status: "confirmed", source: "hand", transactionId: null });
    await db.insert(transactions).values({ accountId: broker, postedOn: "2026-03-03", amountCents: -60_000, description: "BOUGHT ZQXV", externalId: "sync-0" });
    const [{ id: taken }] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.externalId, "sync-0"));
    await db.insert(trades).values({ accountId: broker, on: "2026-02-20", symbol: "ZQXV", side: "buy", quantity: "1", status: "confirmed", source: "hand", transactionId: taken });

    const { rows } = await previewBrokerageImport(db, broker, fileRows());
    const at = (row: number) => rows.find((r) => r.row === row)!;
    expect(at(3)).toMatchObject({ tradePlan: { status: "already", dismissed: false }, linkTo: null });
    // Its cash is already here, but that row settled another trade: the new trade has no cash row.
    expect(at(2)).toMatchObject({ tradePlan: { status: "new" }, cashPlan: { status: "already", existingId: taken }, linkTo: null, ticked: true });
  });

  it("leaves out what an earlier import added", async () => {
    const [first] = fileRows();
    await db.insert(transactions).values({ accountId: broker, postedOn: first.cash!.postedOn, amountCents: first.cash!.amountCents, description: first.cash!.description, externalId: first.id, source: "import" });
    const { rows } = await previewBrokerageImport(db, broker, fileRows());
    expect(rows[0]).toMatchObject({ reimported: true, ticked: false, cashPlan: null, tradePlan: null });
  });
});

describe("the baseline", () => {
  it("won't take a file that holds more on the baseline day than the account did", async () => {
    const { baseline } = await previewBrokerageImport(db, broker, fileRows());
    expect(baseline?.conflicts).toEqual([{ symbol: "ZZIX", short: "1.5" }]);
  });

  it("moves back before the file, shrinks the openings by what it explains, and leaves the holdings it covered alone", async () => {
    const may1 = await confirmedHeld("2026-05-01");
    // The owner unticks the ZZIX buy the account can't have held.
    const preview = await previewBrokerageImport(db, broker, fileRows());
    const ticked = new Set(preview.rows.filter((r) => r.ticked && r.trade?.symbol !== "ZZIX").map((r) => r.id));
    const { rows, baseline } = await previewBrokerageImport(db, broker, fileRows(), ticked);
    const [zqxvOpening] = await db.select().from(trades).where(and(eq(trades.accountId, broker), eq(trades.source, "opening"), eq(trades.symbol, "ZQXV")));
    expect(baseline).toEqual({ from: "2026-05-01", to: "2026-03-01", openings: [{ symbol: "ZQXV", side: "buy", quantity: "5" }], removes: [zqxvOpening.id], conflicts: [] });

    // What trades.import (#356) will write, done here by hand.
    for (const r of rows.filter((x) => ticked.has(x.id) && x.trade)) {
      if (r.tradePlan?.status === "new") await db.insert(trades).values({ accountId: broker, ...r.trade!, status: "confirmed", source: "hand" });
      if (r.tradePlan?.status === "fills_draft")
        await db.update(trades).set({ on: r.trade!.on, onFrom: null, price: r.trade!.price, status: "confirmed", transactionId: synced }).where(eq(trades.id, r.tradePlan.draftId));
    }
    for (const id of baseline!.removes) await db.delete(trades).where(eq(trades.id, id));
    for (const o of baseline!.openings) await db.insert(trades).values({ accountId: broker, on: baseline!.to, ...o, status: "confirmed", source: "opening" });
    await db.update(accounts).set({ tradesBaselineOn: baseline!.to }).where(eq(accounts.id, broker));

    // Today: what the sync reports, the filled draft's 2 shares included. The baseline day: as it was.
    expect(await confirmedHeld()).toEqual(new Map([["ZQXV", "12"], ["ZZIX", "3.5"]]));
    expect(await confirmedHeld("2026-05-01")).toEqual(may1);
    // The file's history is the past now.
    expect((await confirmedHeld("2026-03-31")).get("ZQXV")).toBe("11");
    // And the next sync drafts nothing.
    expect((await planTradeGaps(db, broker))[0].drafts).toEqual([]);
    expect(await draftTradeGaps(db)).toBe(0);
  });

  it("does nothing when the file starts after the baseline, or the account has none yet", () => {
    const later = [{ on: "2026-05-10", symbol: "ZQXV", side: "buy" as const, quantity: "2" }];
    expect(moveBaseline({ baselineOn: "2026-05-01", openings: [], imported: later })).toBeNull();
    expect(moveBaseline({ baselineOn: null, openings: [], imported: [{ ...later[0], on: "2026-01-01" }] })).toBeNull();
  });

  it("removes an opening the file explains entirely, and opens a symbol the file only sold", () => {
    const move = moveBaseline({
      baselineOn: "2026-05-01",
      openings: [{ id: "o1", symbol: "ZQXV", side: "buy", quantity: "4" }],
      imported: [
        { on: "2026-02-01", symbol: "ZQXV", side: "buy", quantity: "4" },
        { on: "2026-02-02", symbol: "ZZIX", side: "sell", quantity: "2" },
      ],
    });
    expect(move).toEqual({ from: "2026-05-01", to: "2026-01-31", openings: [{ symbol: "ZZIX", side: "buy", quantity: "2" }], removes: ["o1"], conflicts: [] });
  });
});
