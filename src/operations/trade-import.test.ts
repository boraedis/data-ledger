import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots, trades, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { readCsv } from "@/lib/history/csv";
import { holdingsOn } from "@/lib/holdings/replay";
import { tallyOperations } from "@/lib/tally/tools";
import { testDb } from "@/lib/test-utils/db";
import { confirmedTrades } from "@/lib/trades/confirmed";
import { draftTradeGaps } from "@/lib/trades/draft-gaps";
import { applyBrokerageMapping, guessBrokerageMapping, type BrokerageRow } from "@/lib/trades/import-csv";
import { listManualPositions } from "@/operations/holdings";
import { execute, read, undoCommand } from "@/operations/runtime";
import { tradeImportMapping } from "@/operations/trade-import";

// Writing a brokerage import (#356): an invented synced brokerage with a
// baseline, a draft from a gap and a synced cash row, and an invented
// export reaching back before the baseline.

let db: Db;
let broker: string;

const FILE = `Date,Type,Ticker,Shares,Net Amount
2026-03-02,Buy,ZQXV,6,-600.00
2026-03-20,Stock Split,ZQXV,6,
2026-04-10,Sell,ZQXV,7,700.00
2026-04-15,Buy,ZZIX,5,-500.00
2026-05-10,Buy,ZQXV,2,-250.00
2026-05-15,Dividend,ZZIX,,3.00
`;
const fileRows = (text = FILE): BrokerageRow[] => {
  const all = readCsv(text);
  const { rows, errors } = applyBrokerageMapping(all, guessBrokerageMapping(all));
  expect(errors).toEqual([]);
  return rows;
};
// Without the ZZIX buy: the account held only 3.5 then (the conflict test keeps it).
const ticked = () => fileRows().filter((r) => r.trade?.symbol !== "ZZIX");

type Out = { commandId: string; output: Record<string, unknown> };
const importRows = (rows: BrokerageRow[], accountId = broker) =>
  execute(db, { operation: "trades.import", input: { accountId, rows, today: "2026-05-20" }, actor: "import", reason: "Imported from a test export" }) as Promise<Out>;
const everything = async () => ({
  trades: (await db.select().from(trades).where(eq(trades.accountId, broker))).sort((a, b) => a.id.localeCompare(b.id)),
  cash: (await db.select().from(transactions).where(eq(transactions.accountId, broker))).sort((a, b) => a.id.localeCompare(b.id)),
  baseline: (await db.select().from(accounts).where(eq(accounts.id, broker)))[0].tradesBaselineOn,
});

let synced: string;
let draftId: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
    .returning({ id: accounts.id });
  const snap = (on: string, zqxv: string) =>
    db.insert(holdingSnapshots).values(
      [
        ["ZQXV", zqxv],
        ["ZZIX", "3.5"],
      ].map(([s, shares]) => ({ accountId: broker, on, externalId: s, symbol: s, description: `${s} Example Fund`, shares, marketValueCents: Math.round(Number(shares) * 12_500), currency: "USD" })),
    );
  await snap("2026-05-01", "10");
  await draftTradeGaps(db);
  await snap("2026-05-20", "12");
  await draftTradeGaps(db);
  [{ id: draftId }] = await db.select({ id: trades.id }).from(trades).where(and(eq(trades.accountId, broker), eq(trades.status, "draft")));
  [{ id: synced }] = await db
    .insert(transactions)
    .values({ accountId: broker, postedOn: "2026-05-11", amountCents: -25_000, description: "YOU BOUGHT ZQXV", externalId: "sync-1" })
    .returning({ id: transactions.id });
});

describe("trades.import", () => {
  it("writes cash rows and linked trades, fills the draft, and moves the baseline", async () => {
    const { output } = await importRows(ticked());
    expect(output).toEqual({ cashRows: 3, trades: 3, draftsFilled: 1, skipped: 0, baselineMovedTo: "2026-03-01" });

    const all = await db.select().from(trades).where(eq(trades.accountId, broker));
    const imported = all.filter((t) => t.source === "import").sort((a, b) => a.on.localeCompare(b.on));
    expect(imported.map((t) => [t.on, t.kind, t.side, t.quantity, t.price, t.status])).toEqual([
      ["2026-03-02", "trade", "buy", "6", "100", "confirmed"],
      ["2026-03-20", "split", "buy", "6", null, "confirmed"],
      ["2026-04-10", "trade", "sell", "7", "100", "confirmed"],
    ]);
    // Each buy and sell links to the cash row it brought; the split has none.
    const cash = await db.select().from(transactions).where(and(eq(transactions.accountId, broker), eq(transactions.source, "import")));
    expect(cash.map((c) => [c.postedOn, c.amountCents, c.merchantId]).sort()).toEqual([
      ["2026-03-02", -60_000, null],
      ["2026-04-10", 70_000, null],
      ["2026-05-15", 300, null],
    ]);
    for (const t of imported.filter((x) => x.kind === "trade")) expect(cash.find((c) => c.id === t.transactionId)?.postedOn).toBe(t.on);
    // The draft is the file's buy, on its day, settled through the synced row.
    const [filled] = all.filter((t) => t.id === draftId);
    expect(filled).toMatchObject({ status: "confirmed", on: "2026-05-10", onFrom: null, price: "125", transactionId: synced });
    // The opening shrank to what the file doesn't explain: 10 − (6 + 6 − 7) = 5, on the new baseline.
    expect(all.filter((t) => t.source === "opening").map((t) => [t.symbol, t.quantity, t.on]).sort()).toEqual([
      ["ZQXV", "5", "2026-03-01"],
      ["ZZIX", "3.5", "2026-05-01"],
    ]);
    const confirmed = await confirmedTrades(db, eq(trades.accountId, broker));
    expect(holdingsOn(confirmed, "2026-05-01")).toEqual(new Map([["ZQXV", "10"], ["ZZIX", "3.5"]]));
    expect(holdingsOn(confirmed)).toEqual(new Map([["ZQXV", "12"], ["ZZIX", "3.5"]]));
    expect(await draftTradeGaps(db)).toBe(0);
  });

  it("adds nothing the second time, the split included", async () => {
    await importRows(ticked());
    const after = await everything();
    const { output } = await importRows(ticked());
    expect(output).toMatchObject({ cashRows: 0, trades: 0, draftsFilled: 0, baselineMovedTo: null });
    expect(await everything()).toEqual(after);
  });

  it("is undone as a whole", async () => {
    const before = await everything();
    const { commandId } = await importRows(ticked());
    await undoCommand(db, commandId);
    const after = await everything();
    // Undo brings the removed opening back as it was; nothing else differs.
    expect(after.baseline).toBe(before.baseline);
    expect(after.cash).toEqual(before.cash);
    const shape = (list: typeof before.trades) => list.map(({ createdAt, ...t }) => (void createdAt, t)).sort((a, b) => a.id.localeCompare(b.id));
    expect(shape(after.trades)).toEqual(shape(before.trades));
  });

  it("refuses a file that holds more than the account did on its baseline, and writes nothing", async () => {
    const before = await everything();
    await expect(importRows(fileRows())).rejects.toThrow(/1.5 more ZZIX on 2026-05-01/);
    expect(await everything()).toEqual(before);
  });

  it("follows the trades in a manual account's positions", async () => {
    const { output } = (await execute(db, { operation: "accounts.createManual", input: { name: "Example manual brokerage", kind: "other_asset", valueCents: 0, on: "2026-05-01" }, actor: "user", reason: "test" })) as Out;
    const manual = (output as { id: string }).id;
    await importRows(fileRows(`Date,Type,Ticker,Shares,Price,Net Amount\n2026-05-01,Buy,ZQXV,4,100,-400.00\n2026-05-02,Sell,ZQXV,1,110,110.00\n`), manual);
    expect((await listManualPositions(db)).filter((p) => p.accountId === manual).map((p) => [p.symbol, p.quantity])).toEqual([["ZQXV", "3"]]);
  });

  it("isn't one of Tally's tools", () => {
    expect(tallyOperations().some((op) => op.name === "trades.import")).toBe(false);
  });
});

describe("an account's saved layout (#357)", () => {
  it("is saved and read back, replaced the second time, and only for an investment account", async () => {
    const all = readCsv(FILE);
    const mapping = guessBrokerageMapping(all);
    const save = (accountId: string, m = mapping) => execute(db, { operation: "trades.saveImportMapping", input: { accountId, mapping: m }, actor: "user", reason: "test" });
    await save(broker);
    expect(await read(db, tradeImportMapping, { accountId: broker })).toEqual(mapping);
    await save(broker, { ...mapping, actions: { ...mapping.actions, MYSTERY: "ignore" } });
    expect((await read(db, tradeImportMapping, { accountId: broker }))?.actions.MYSTERY).toBe("ignore");

    const [{ id: checking }] = await db
      .insert(accounts)
      .values({ name: "Everyday Checking", institution: "Example Bank", type: "checking", source: "simplefin", externalId: "c1" })
      .returning({ id: accounts.id });
    await expect(save(checking)).rejects.toThrow(/brokerage or retirement/);
  });

  it("is the owner's alone", () => {
    const names = tallyOperations().map((op) => op.name);
    expect(names).not.toContain("trades.importMapping");
    expect(names).not.toContain("trades.saveImportMapping");
  });
});
