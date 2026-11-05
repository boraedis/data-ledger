import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, holdingSnapshots, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { tradedSymbols } from "@/lib/prices/backfill";
import { tallyOperations } from "@/lib/tally/tools";
import { testDb } from "@/lib/test-utils/db";
import { listManualPositions } from "@/operations/holdings";
import { execute, read, undoCommand } from "@/operations/runtime";
import { draftCounts, draftTotal, listTradesRead } from "@/operations/trades";

// Draft trades (#318): inferred, partly filled in, and counted nowhere until
// the owner confirms them. Invented accounts, symbols and quantities.

let db: Db;
let broker: string;
let wallet: string;
type Out = { commandId: string; output: { id: string } };
const run = (operation: string, input: Record<string, unknown>, actor = "user") =>
  execute(db, { operation, input, actor: actor as "user", reason: "test" }) as Promise<Out>;
const day = new Date().toISOString().slice(0, 10);
const row = async (id: string) => (await db.select().from(trades).where(eq(trades.id, id)))[0];
const position = async (symbol: string) => (await listManualPositions(db)).find((p) => p.symbol === symbol);

beforeEach(async () => {
  db = await testDb();
  [{ id: broker }] = await db
    .insert(accounts)
    .values({ name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage", source: "simplefin", externalId: "b1", balanceCents: 1_000_000, countsTowardBudgets: false })
    .returning({ id: accounts.id });
  wallet = (await run("accounts.createManual", { name: "Coin wallet", kind: "other_asset", valueCents: 0, on: day })).output.id;
});

describe("a draft", () => {
  it("can be saved with no symbol, price or exact day, finished, and confirmed", async () => {
    const draft = await run("trades.draft", { accountId: broker, positionId: "pos-77", side: "buy", quantity: "2", onFrom: "2026-05-03", on: "2026-05-05" }, "import");
    expect(await row(draft.output.id)).toMatchObject({ status: "draft", source: "position_gap", symbol: null, positionId: "pos-77", price: null, onFrom: "2026-05-03", on: "2026-05-05" });

    await expect(run("trades.confirm", { tradeId: draft.output.id })).rejects.toThrow(/symbol/);
    await run("trades.update", { tradeId: draft.output.id, symbol: "zqxv" });
    await expect(run("trades.confirm", { tradeId: draft.output.id })).rejects.toThrow(/day/);
    // Narrowing the range to one day makes it one day.
    await run("trades.update", { tradeId: draft.output.id, onFrom: "2026-05-04", on: "2026-05-04" });
    expect(await row(draft.output.id)).toMatchObject({ symbol: "ZQXV", onFrom: null, on: "2026-05-04" });

    await run("trades.confirm", { tradeId: draft.output.id });
    expect(await row(draft.output.id)).toMatchObject({ status: "confirmed", price: null });
  });

  it("needs a symbol or a position, and a range that runs forward", async () => {
    await expect(run("trades.draft", { accountId: broker, side: "buy", quantity: "2", on: "2026-05-05" }, "import")).rejects.toThrow();
    await expect(run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "buy", quantity: "2", onFrom: "2026-05-06", on: "2026-05-05" }, "import")).rejects.toThrow();
  });

  it("counts nowhere until confirmed: not the log or the history's symbols", async () => {
    await db.insert(holdingSnapshots).values({ accountId: broker, on: "2026-05-05", externalId: "ZQXV", symbol: "ZQXV", description: "Example Growth Fund", shares: "2", marketValueCents: 25_000, currency: "USD" });
    await run("trades.add", { accountId: broker, on: "2026-04-01", symbol: "ZZIX", side: "buy", quantity: "1" });
    const draft = await run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "buy", quantity: "2", on: "2026-05-04" }, "import");

    expect((await read(db, listTradesRead, { status: "confirmed" })).map((t) => t.symbol)).toEqual(["ZZIX"]);
    expect((await tradedSymbols(db)).map((s) => s.symbol)).toEqual(["ZZIX"]);

    await run("trades.confirm", { tradeId: draft.output.id });
    expect((await read(db, listTradesRead, { status: "confirmed" })).map((t) => t.symbol).sort()).toEqual(["ZQXV", "ZZIX"]);
  });

  it("in a manual account moves no position until confirmed, and undoing the confirm puts it back", async () => {
    await run("trades.add", { accountId: wallet, on: "2026-03-01", symbol: "ZQC", side: "buy", quantity: "1", price: "30000" });
    const draft = await run("trades.draft", { accountId: wallet, symbol: "ZQC", side: "buy", quantity: "0.5", on: "2026-03-10" }, "user");
    expect(await position("ZQC")).toMatchObject({ quantity: "1" });

    const confirmed = await run("trades.confirm", { tradeId: draft.output.id });
    expect(await position("ZQC")).toMatchObject({ quantity: "1.5" });
    await undoCommand(db, confirmed.commandId);
    expect(await position("ZQC")).toMatchObject({ quantity: "1" });
    expect(await row(draft.output.id)).toMatchObject({ status: "draft" });
  });
});

describe("dismissing and restoring", () => {
  it("keeps a dismissed draft, brings it back, and each step undoes on its own", async () => {
    const draft = await run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "sell", quantity: "1", on: "2026-05-04" }, "matcher");
    const dismissed = await run("trades.dismiss", { tradeId: draft.output.id });
    expect(await row(draft.output.id)).toMatchObject({ status: "dismissed" });
    await expect(run("trades.confirm", { tradeId: draft.output.id })).rejects.toThrow(/Restore/);

    await undoCommand(db, dismissed.commandId);
    expect(await row(draft.output.id)).toMatchObject({ status: "draft" });
    await run("trades.dismiss", { tradeId: draft.output.id });
    await run("trades.restore", { tradeId: draft.output.id });
    expect(await row(draft.output.id)).toMatchObject({ status: "draft" });

    await undoCommand(db, draft.commandId);
    expect(await row(draft.output.id)).toBeUndefined();
  });

  it("only applies to drafts, and a confirmed trade's symbol can't be edited", async () => {
    const { output } = await run("trades.add", { accountId: broker, on: "2026-04-01", symbol: "ZZIX", side: "buy", quantity: "1" });
    await expect(run("trades.dismiss", { tradeId: output.id })).rejects.toThrow(/draft/);
    await expect(run("trades.restore", { tradeId: output.id })).rejects.toThrow(/dismissed/);
    await expect(run("trades.update", { tradeId: output.id, symbol: "ZQXV" })).rejects.toThrow(/draft/);
  });
});

describe("who may", () => {
  it("never offers a trade operation to Tally", () => {
    expect(tallyOperations().filter((op) => op.name.startsWith("trades."))).toEqual([]);
  });

  it("lets only the owner finish a draft, and the sync or matcher make one", async () => {
    const draft = await run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "buy", quantity: "1", on: "2026-05-04" }, "import");
    for (const op of ["trades.confirm", "trades.dismiss"]) await expect(run(op, { tradeId: draft.output.id }, "matcher")).rejects.toThrow();
    await expect(run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "buy", quantity: "1", on: "2026-05-04" }, "tally")).rejects.toThrow();
  });
});

describe("the migration", () => {
  it("leaves existing trades confirmed and hand-entered, and the database refuses an incomplete confirmed one", async () => {
    await db.execute(sql`insert into trades (account_id, "on", symbol, side, quantity) values (${broker}, '2026-01-02', 'ZZIX', 'buy', '3')`);
    const [old] = await db.select().from(trades);
    expect(old).toMatchObject({ status: "confirmed", source: "hand", onFrom: null, transactionId: null });
    await expect(db.execute(sql`insert into trades (account_id, "on", position_id, side, quantity) values (${broker}, '2026-01-02', 'p', 'buy', '3')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into trades (account_id, "on", side, quantity, status) values (${broker}, '2026-01-02', 'buy', '3', 'draft')`)).rejects.toThrow();
  });
});

describe("the Trades page's list (#319)", () => {
  it("filters by account, status, symbol and dates, and counts drafts per account", async () => {
    await run("trades.add", { accountId: broker, on: "2026-04-01", symbol: "ZZIX", side: "buy", quantity: "1" });
    await run("trades.add", { accountId: wallet, on: "2026-04-02", symbol: "ZQC", side: "buy", quantity: "1", price: "30000" });
    await run("trades.draft", { accountId: broker, symbol: "ZQXV", side: "buy", quantity: "2", onFrom: "2026-05-03", on: "2026-05-05" }, "import");
    const symbols = async (input: Parameters<typeof listTradesRead.run>[1] | Record<string, unknown>) => (await read(db, listTradesRead, input as never)).map((t) => t.symbol);

    expect(await symbols({})).toEqual(["ZQXV", "ZQC", "ZZIX"]);
    expect(await symbols({ accountId: broker })).toEqual(["ZQXV", "ZZIX"]);
    expect(await symbols({ status: "draft" })).toEqual(["ZQXV"]);
    expect(await symbols({ symbol: "zqc" })).toEqual(["ZQC"]);
    expect(await symbols({ from: "2026-04-02", to: "2026-04-30" })).toEqual(["ZQC"]);
    expect(await draftCounts(db)).toEqual(new Map([[broker, 1]]));
    // What the Inbox, the Trades tab and Tally's summary show (#325).
    expect(await draftTotal(db)).toBe(1);
    await run("trades.dismiss", { tradeId: (await read(db, listTradesRead, { status: "draft" }))[0].id });
    expect(await draftTotal(db)).toBe(0);
  });

  it("is the owner's alone", () => {
    expect(listTradesRead.allowedActors).toEqual(["user"]);
  });
});
