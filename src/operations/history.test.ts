import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applyMapping, readCsv, type Mapping } from "@/lib/history/csv";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { getImportMapping } from "@/operations/history";
import { execute, read, undoCommand } from "@/operations/runtime";

// History import (#35) against the synthetic seed, with a synthetic export
// from before the seed's window. No real file anywhere.

let db: Db;
let checkingId: string;
let brokerageId: string;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: checkingId }] = await db.select().from(accounts).where(eq(accounts.type, "checking"));
  [{ id: brokerageId }] = await db.select().from(accounts).where(eq(accounts.type, "brokerage"));
});

const mapping: Mapping = { skipRows: 0, hasHeader: true, date: 0, dateFormat: "MM/DD/YYYY", description: 1, amount: { kind: "signed", column: 2, flip: false } };
const file = [
  "Date,Description,Amount",
  "01/03/2025,MAPLEWOOD PROPERTY MGMT ONLINE PMT RENT,-1850.00",
  "01/05/2025,CORNER BEAN CAFE,-4.50",
  "01/05/2025,CORNER BEAN CAFE,-4.50",
  "01/15/2025,ACME WIDGETS INC DIRECT DEP PAYROLL,2450.00",
].join("\n");
const rows = applyMapping(readCsv(file), mapping).rows.map(({ postedOn, amountCents, description, externalId }) => ({ postedOn, amountCents, description, externalId }));
const run = (operation: string, input: Record<string, unknown>, actor: "import" | "user" | "tally" = "import") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const imported = () => db.select().from(transactions).where(and(eq(transactions.accountId, checkingId), eq(transactions.source, "import")));

describe("history.import", () => {
  it("adds the rows as imported, with merchant names, in one undoable command", async () => {
    const result = await run("history.import", { accountId: checkingId, rows });
    expect(result.output).toEqual({ inserted: 4, alreadyImported: 0 });
    const added = await imported();
    expect(added.map((t) => [t.postedOn, t.amountCents, t.merchant]).sort()).toEqual([
      ["2025-01-03", -185_000, "Maplewood Property Mgmt Rent"],
      ["2025-01-05", -450, "Corner Bean Cafe"],
      ["2025-01-05", -450, "Corner Bean Cafe"],
      ["2025-01-15", 245_000, "Acme Widgets Inc Direct Dep Payroll"],
    ]);
    expect(await db.select().from(commandLog).where(eq(commandLog.operation, "history.import"))).toHaveLength(1);

    await undoCommand(db, result.commandId);
    expect(await imported()).toEqual([]);
  });

  it("adds nothing the second time the same file is imported", async () => {
    await run("history.import", { accountId: checkingId, rows });
    expect((await run("history.import", { accountId: checkingId, rows })).output).toEqual({ inserted: 0, alreadyImported: 4 });
    expect(await imported()).toHaveLength(4);
  });

  it("is the import path's alone, and not for investment accounts", async () => {
    await expect(run("history.import", { accountId: checkingId, rows }, "user")).rejects.toThrow(/may not run/);
    await expect(run("history.import", { accountId: checkingId, rows }, "tally")).rejects.toThrow(/may not run/);
    await expect(run("history.import", { accountId: brokerageId, rows })).rejects.toThrow(/not investment accounts/);
  });
});

describe("history mapping", () => {
  it("saves one per account, as the owner, and reads it back", async () => {
    expect(await read(db, getImportMapping, { accountId: checkingId })).toBeNull();
    await run("history.saveMapping", { accountId: checkingId, mapping }, "user");
    await run("history.saveMapping", { accountId: checkingId, mapping: { ...mapping, skipRows: 2 } }, "user");
    expect(await read(db, getImportMapping, { accountId: checkingId })).toEqual({ ...mapping, skipRows: 2 });
  });
});
