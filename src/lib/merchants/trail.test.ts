import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, merchants } from "@/db/schema";
import type { Db } from "@/db/types";
import { merchantExplanation, merchantTrail } from "@/lib/merchants/trail";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// A transaction's merchant trail (#290), on the synthetic seed with
// invented merchants.

let db: Db;
let p2p: string;
const run = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ commandId: string; output: unknown }>;
const addManual = async (description: string) =>
  ((await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -900, description })).output as { transactionId: string }).transactionId;
const merchantId = async (name: string) => (await db.select().from(merchants).where(eq(merchants.name, name)))[0].id;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
});

describe("the merchant trail", () => {
  it("shows the arrival and a merge, and drops the merge once it's undone", async () => {
    await addManual("Fernwood Bakery");
    const id = await addManual("Fernwood Bakery Cafe");
    const [keep, gone] = [await merchantId("Fernwood Bakery"), await merchantId("Fernwood Bakery Cafe")];
    const merged = await run("merchants.merge", { keepId: keep, mergeId: gone });

    const trail = await merchantTrail(db, id);
    expect(trail.map((t) => t.operation)).toEqual(["transactions.createManual", "merchants.merge"]);
    expect(trail[0]).toMatchObject({ from: null, toName: "Fernwood Bakery Cafe", to: { id: gone, name: null } });
    // The merged merchant is gone, so it has no name now.
    expect(trail[1]).toMatchObject({ from: { id: gone, name: null }, to: { id: keep, name: "Fernwood Bakery" } });

    const info = await merchantExplanation(db, id);
    expect(info).toMatchObject({ stored: "Fernwood Bakery Cafe", merchant: { id: keep }, aliasMatched: true, pinned: false });
    expect(info!.explanation.source).toBe("description");

    await undoCommand(db, merged.commandId);
    expect((await merchantTrail(db, id)).map((t) => t.operation)).toEqual(["transactions.createManual"]);
  });
});
