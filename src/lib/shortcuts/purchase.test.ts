import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, transactions, unmappedWalletCards } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { parseAmount, purchaseDate, purchaseNotification, recordPurchase } from "@/lib/shortcuts/purchase";
import { createToken, listTokens, revokeToken, verifyBearer } from "@/lib/shortcuts/tokens";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// The Apple Pay Shortcut against the synthetic seed (ends 2026-06-30).

describe("parseAmount", () => {
  it("reads what a Shortcut sends as money out, refunds as money in", () => {
    expect(parseAmount("$12.34")).toBe(-1234);
    expect(parseAmount(12.34)).toBe(-1234);
    expect(parseAmount("$1,234.56")).toBe(-123456);
    expect(parseAmount("1.234,56 €")).toBe(-123456);
    expect(parseAmount("12,5")).toBe(-1250);
    expect(parseAmount("1,234")).toBe(-123400);
    expect(parseAmount("-$5.00")).toBe(500);
    expect(parseAmount("12.34 USD")).toBe(-1234);
    expect(parseAmount(".99")).toBe(-99);
  });

  it("refuses what isn't an amount", () => {
    for (const bad of ["", "free", "$0.00", "1.2.3.4x5", "12 34", "1,23,456.00"]) expect(parseAmount(bad)).toBeNull();
  });
});

it("takes the purchase date from the phone's own clock when given", () => {
  expect(purchaseDate("2026-07-02T21:15:00-07:00")).toBe("2026-07-02");
  expect(purchaseDate("whenever")).toBe(new Date().toISOString().slice(0, 10));
});

describe("recordPurchase", () => {
  let db: Db;
  let card: string;
  beforeEach(async () => {
    db = await testDb();
    await applySeed(db, { endDate: new Date("2026-06-30") });
    [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  });
  const body = { merchant: "Lumen Bistro", amount: "$42.10", card: "Example Rewards", at: "2026-07-02T19:30:00-07:00" };

  it("remembers an unmapped card's name and records nothing", async () => {
    expect(await recordPurchase(db, body)).toEqual({ status: "unmapped", card: "Example Rewards" });
    expect(await db.select().from(unmappedWalletCards)).toEqual([expect.objectContaining({ name: "Example Rewards" })]);
  });

  it("creates a provisional transaction on the mapped account, once", async () => {
    await execute(db, { operation: "accounts.update", actor: "user", reason: "Test", input: { accountId: card, walletCardName: "example rewards" } });
    const first = await recordPurchase(db, body);
    expect(first).toMatchObject({ status: "created", accountId: card, amountCents: -4210 });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, (first as { transactionId: string }).transactionId));
    expect(row).toMatchObject({ provisionalSource: "apple_pay", postedOn: "2026-07-02", amountCents: -4210, description: "Lumen Bistro" });
    expect(await recordPurchase(db, body)).toMatchObject({ status: "duplicate", transactionId: row.id });
    // A minute later is another purchase.
    expect(await recordPurchase(db, { ...body, at: "2026-07-02T19:31:00-07:00" })).toMatchObject({ status: "created" });

    expect(purchaseNotification(body, first as never)).toEqual({
      title: "Lumen Bistro · $42.10",
      body: "Example Rewards · tap to categorize",
      url: `/transactions/${row.id}/quick`,
      tag: `purchase-${row.id}`,
    });
  });

  it("won't map one Wallet name to two accounts", async () => {
    const [other] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Everyday Checking"));
    await execute(db, { operation: "accounts.update", actor: "user", reason: "Test", input: { accountId: card, walletCardName: "Example Rewards" } });
    await expect(
      execute(db, { operation: "accounts.update", actor: "user", reason: "Test", input: { accountId: other.id, walletCardName: "EXAMPLE REWARDS" } }),
    ).rejects.toThrow(/already uses/);
  });
});

describe("tokens", () => {
  it("accepts only a live token, stores only its hash, and stops at revoke", async () => {
    const db = await testDb();
    const { id, token } = await createToken(db, "iPhone");
    expect(token).toMatch(/^dlsc_/);
    expect(JSON.stringify(await db.query.shortcutTokens.findMany())).not.toContain(token);

    expect(await verifyBearer(db, `Bearer ${token}`)).toEqual({ id, label: "iPhone" });
    expect((await listTokens(db))[0].lastUsedAt).not.toBeNull();
    expect(await verifyBearer(db, token)).toBeNull();
    expect(await verifyBearer(db, `Bearer ${token}x`)).toBeNull();
    expect(await verifyBearer(db, null)).toBeNull();

    await revokeToken(db, id);
    expect(await verifyBearer(db, `Bearer ${token}`)).toBeNull();
  });
});
