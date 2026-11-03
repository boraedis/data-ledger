import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";
import { pairingCandidates } from "@/operations/transactions";

// Pairing an unpaired transfer with a row that already exists (#252), on the
// synthetic seed: its card payment (out of checking) and the matching credit
// on the card stand in for a real transfer's two sides.

let db: Db;
let payment: typeof transactions.$inferSelect;
let credit: typeof transactions.$inferSelect;

const user = (operation: string, input: Record<string, unknown>) =>
  execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  await runCategorization(db);
  [payment] = await db.select().from(transactions).where(eq(transactions.description, "PLACEHOLDER CARD CO PAYMENT")).limit(1);
  [credit] = await db.select().from(transactions).where(eq(transactions.amountCents, -payment.amountCents));
});

describe("pairingCandidates", () => {
  it("offers nothing for a pair the matcher already made", async () => {
    expect(payment.transferPairId).toBe(credit.id);
    expect(await pairingCandidates(db, payment.id)).toEqual([]);
  });

  it("offers the other side again after Not a transfer, which rejected both, and pairing clears the rejection", async () => {
    await user("transactions.unmatchTransfer", { transactionId: payment.id });
    expect(await row(payment.id)).toMatchObject({ transferPairId: null, transferRejected: true });

    const found = await pairingCandidates(db, payment.id);
    expect(found.map((c) => c.id)).toEqual([credit.id]);
    expect(found[0]).toMatchObject({ accountName: "Rewards Card", description: "PAYMENT THANK YOU" });
    // From the other side too.
    expect((await pairingCandidates(db, credit.id)).map((c) => c.id)).toEqual([payment.id]);

    const result = await user("transactions.pairAsTransfer", { outId: payment.id, inId: credit.id });
    expect(await row(payment.id)).toMatchObject({ transferPairId: credit.id, transferRejected: false });
    expect(await row(credit.id)).toMatchObject({ transferPairId: payment.id, transferRejected: false });
    expect(await pairingCandidates(db, payment.id)).toEqual([]);

    await undoCommand(db, result.commandId);
    expect(await row(payment.id)).toMatchObject({ transferPairId: null, transferRejected: true });
  });

  it("leaves out rows outside the window, and rows already paired to something else", async () => {
    await user("transactions.unmatchTransfer", { transactionId: payment.id });
    // Outside the pairing window.
    await db.update(transactions).set({ postedOn: "2020-01-01" }).where(eq(transactions.id, credit.id));
    expect(await pairingCandidates(db, payment.id)).toEqual([]);
    await db.update(transactions).set({ postedOn: payment.postedOn }).where(eq(transactions.id, credit.id));
    expect((await pairingCandidates(db, payment.id)).map((c) => c.id)).toEqual([credit.id]);
    // Paired to some other row.
    await db.update(transactions).set({ transferPairId: payment.id }).where(eq(transactions.id, credit.id));
    expect(await pairingCandidates(db, payment.id)).toEqual([]);
  });
});
