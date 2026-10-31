import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, alerts, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { matchProvisionalStep } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { checkPurchase } from "@/lib/shortcuts/purchase";
import { testDb } from "@/lib/test-utils/db";
import { listAlerts } from "@/operations/recurring";
import { execute, read, undoCommand } from "@/operations/runtime";
import { listFlags } from "@/operations/suspicious";

// Suspicious-charge checks (#33) against the synthetic seed, which ends on
// 2026-06-30. Merchants and amounts are invented.

let db: Db;
let card: string;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
});

type Applied = { status: string; commandId: string; output: unknown };
const check = async (input: Record<string, unknown> = { on: "2026-07-04" }) => {
  const result = (await execute(db, { operation: "alerts.checkSuspicious", actor: "matcher", reason: "Test", input })) as Applied;
  return result.output as { raised: number; alertIds: string[] };
};
const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, actor: "user", reason: "Test", input }) as Promise<Applied>;

let n = 0;
async function charge(postedOn: string, dollars: number, merchant = "Velvet Lane Outfitters", extra: Partial<typeof transactions.$inferInsert> = {}) {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: card, postedOn, amountCents: -Math.round(dollars * 100), description: merchant.toUpperCase(), merchant, externalId: `bank-${++n}`, ...extra })
    .returning();
  return row;
}

describe("the nightly check", () => {
  it("raises a flag for a recent charge as an alert, once", async () => {
    const big = await charge("2026-07-02", 320);
    expect((await check()).raised).toBe(1);
    const [flag] = await db.select().from(alerts).where(eq(alerts.transactionId, big.id));
    expect(flag).toMatchObject({ kind: "new_merchant", amountCents: 32_000, verdict: null, dismissedAt: null });
    expect((await check()).raised).toBe(0);
  });

  it("checks only the last week, and leaves out the owner's own entries and imported history", async () => {
    await charge("2026-06-20", 320);
    await charge("2026-07-02", 330, "Harbor Looms", { source: "manual" });
    await charge("2026-07-02", 340, "Copperleaf Tiles", { source: "import" });
    expect((await check()).raised).toBe(0);
  });

  it("doesn't flag a charge a subscription alert is already about", async () => {
    const big = await charge("2026-07-02", 320);
    await db.insert(alerts).values({ kind: "price_increase", dedupeKey: "test", merchant: "Velvet Lane Outfitters", accountId: card, transactionId: big.id, title: "t", detail: "d", occurredOn: "2026-07-02" });
    expect((await check()).raised).toBe(0);
  });
});

describe("as an Apple Pay purchase arrives", () => {
  it("flags the purchase, and the flag follows it to the bank's copy instead of being raised again", async () => {
    const created = (await execute(db, {
      operation: "transactions.createProvisional",
      actor: "alert",
      reason: "Apple Pay purchase",
      input: { accountId: card, postedOn: "2026-07-02", amountCents: -32_000, description: "VELVET LANE OUTFITTERS", source: "apple_pay", ref: "ref-1" },
    })) as Applied;
    const provisionalId = (created.output as { transactionId: string }).transactionId;
    const flag = await checkPurchase(db, provisionalId);
    expect(flag?.title).toContain("First charge from");

    const bank = await charge("2026-07-03", 320, "Velvet Lane Outfitters", { createdAt: new Date(Date.now() + 60_000) });
    await matchProvisionalStep(db);
    const [moved] = await db.select().from(alerts).where(eq(alerts.id, flag!.alertId));
    expect(moved.transactionId).toBe(bank.id);
    expect((await check()).raised).toBe(0);
  });
});

describe("the owner's verdict", () => {
  it("takes it off the review list, keeps a suspicious one in view, and can be undone", async () => {
    await charge("2026-07-02", 320);
    await charge("2026-07-02", 450, "Copperleaf Tiles");
    const { alertIds } = await check();
    expect((await read(db, listFlags, {})).open).toHaveLength(2);

    await run("alerts.review", { alertId: alertIds[0], verdict: "fine" });
    const suspicious = await run("alerts.review", { alertId: alertIds[1], verdict: "suspicious" });
    const flags = await read(db, listFlags, {});
    expect(flags.open).toEqual([]);
    expect(flags.suspicious.map((f) => f.id)).toEqual([alertIds[1]]);
    expect((await read(db, listAlerts, {})).map((a) => a.id)).not.toContain(alertIds[0]);

    await undoCommand(db, suspicious.commandId, { actor: "user", reason: "Test" });
    expect((await read(db, listFlags, {})).open.map((f) => f.id)).toEqual([alertIds[1]]);
  });

  it("tunes the next check: an amount called fine at a merchant isn't unusual there again", async () => {
    for (const d of ["2026-03-05", "2026-04-05", "2026-05-05"]) await charge(d, 40, "Lantern Books");
    await charge("2026-06-28", 200, "Lantern Books");
    const { alertIds } = await check({ on: "2026-06-30" });
    expect(alertIds).toHaveLength(1);
    await run("alerts.review", { alertId: alertIds[0], verdict: "fine" });

    await charge("2026-07-02", 230, "Lantern Books");
    expect((await check()).raised).toBe(0);
  });

  it("is only for suspicious-charge alerts", async () => {
    const [sub] = await db
      .insert(alerts)
      .values({ kind: "price_increase", dedupeKey: "test", merchant: "Tunebox", title: "t", detail: "d", occurredOn: "2026-07-02" })
      .returning();
    await expect(run("alerts.review", { alertId: sub.id, verdict: "fine" })).rejects.toThrow(/dismiss/);
  });
});
