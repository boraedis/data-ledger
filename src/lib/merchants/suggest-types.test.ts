import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, commandLog, merchants, merchantTypes, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { pendingTypeSuggestions, suggestMerchantTypes, type AskTypes } from "@/lib/merchants/suggest-types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { approveProposal, execute, rejectProposal } from "@/operations/runtime";

// Suggesting merchant types (#293) on the synthetic seed, with a stand-in
// for the model and invented merchants.

let db: Db;
let card: string;
let type: Record<string, string>;
let cat: Record<string, string>;
let asked: string[][];

// The stand-in model: sure about tea rooms, unsure about everything else.
const ask: AskTypes = async (types, names) => {
  asked.push(names);
  const cafe = types.find((t) => t.name === "Cafe")!.id;
  return names.map((n) => (n.includes("Tea Room") ? { typeId: cafe, confidence: 0.92 } : { typeId: cafe, confidence: 0.4 }));
};

const merchant = async (name: string) => (await db.insert(merchants).values({ name }).returning())[0].id;
let n = 0;
const charge = (merchantId: string, name: string, categoryId: string | null) =>
  db.insert(transactions).values({ accountId: card, postedOn: "2026-06-01", amountCents: -1_200, description: name.toUpperCase(), merchant: name, merchantId, categoryId, externalId: `ty-${++n}` });
const typeOf = async (id: string) => (await db.select().from(merchants).where(eq(merchants.id, id)))[0].typeId;

let diner: string;
let tea: string;
let vague: string;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  // Only this test's merchants are without a type, so the counts below are theirs.
  const [anyType] = await db.select().from(merchantTypes).limit(1);
  await db.update(merchants).set({ typeId: anyType.id });
  [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
  type = Object.fromEntries((await db.select().from(merchantTypes)).map((t) => [t.name, t.id]));
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  asked = [];
  diner = await merchant("Marigold Diner");
  for (let i = 0; i < 3; i++) await charge(diner, "Marigold Diner", cat.Dining);
  tea = await merchant("Quillon Tea Room");
  vague = await merchant("JKL Holdings");
});

describe("suggesting merchant types", () => {
  it("proposes from a consistent category first, then from the name, and nothing when unsure", async () => {
    const result = await suggestMerchantTypes(db, { ask });
    expect(result).toMatchObject({ fromCategory: 1, fromModel: 1, asked: 2 });
    // The model only ever sees names: the one placed by category isn't sent.
    expect(asked).toEqual([["Quillon Tea Room", "JKL Holdings"]]);
    const pending = await pendingTypeSuggestions(db);
    expect(pending.map((p) => [p.merchantName, p.typeName, p.source]).sort()).toEqual([
      ["Marigold Diner", "Restaurant", "category"],
      ["Quillon Tea Room", "Cafe", "name"],
    ]);
    expect(pending.find((p) => p.source === "name")!.reason).toContain("92% confident");
    // Proposals only: nothing is typed yet.
    expect(await typeOf(diner)).toBeNull();
    expect(await typeOf(vague)).toBeNull();
  });

  it("doesn't propose twice, ask the model twice, or bring back a rejected one", async () => {
    await suggestMerchantTypes(db, { ask });
    const [first] = await pendingTypeSuggestions(db);
    await rejectProposal(db, first.commandId);
    expect(await suggestMerchantTypes(db, { ask })).toMatchObject({ fromCategory: 0, fromModel: 0, asked: 0 });
    expect(asked).toHaveLength(1);
  });

  it("applies on approval, but never over a type the owner set meanwhile", async () => {
    await suggestMerchantTypes(db, { ask });
    const pending = await pendingTypeSuggestions(db);
    const forDiner = pending.find((p) => p.merchantId === diner)!;
    await approveProposal(db, forDiner.commandId);
    expect(await typeOf(diner)).toBe(type.Restaurant);

    const forTea = pending.find((p) => p.merchantId === tea)!;
    await execute(db, { operation: "merchants.setType", input: { merchantId: tea, typeId: type.Bar }, actor: "user", reason: "test" });
    // Set by the owner: no longer waiting, and approving it anyway changes nothing.
    expect((await pendingTypeSuggestions(db)).some((p) => p.merchantId === tea)).toBe(false);
    await expect(approveProposal(db, forTea.commandId)).rejects.toThrow(/already has a type/);
    expect(await typeOf(tea)).toBe(type.Bar);
  });

  it("asks nothing of the model when it's off", async () => {
    expect(await suggestMerchantTypes(db, { ask, model: false })).toMatchObject({ fromCategory: 1, fromModel: 0, asked: 0 });
    expect(asked).toHaveLength(0);
    expect((await db.select().from(commandLog).where(eq(commandLog.operation, "merchants.recordTypeAsks"))).length).toBe(0);
  });
});
