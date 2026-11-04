import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, merchants, rules, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { runCategorization } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listRules, matchPreview } from "@/operations/rules";
import { execute, read, undoCommand } from "@/operations/runtime";
import { listInbox } from "@/operations/transactions";

// Rules and merchant memory on the merchant (#289), not the spelling, on
// the synthetic seed. Invented merchants and descriptions only.

let db: Db;
let p2p: string;
let cat: Record<string, string>;

type Out = { status: string; commandId: string; output: unknown };
const run = (operation: string, input: Record<string, unknown>) => execute(db, { operation, input, actor: "user", reason: "test" }) as Promise<Out>;
const addManual = async (description: string, categoryId?: string) =>
  ((await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -1_250, description, categoryId })).output as { transactionId: string })
    .transactionId;
const txn = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const merchantId = async (name: string) => (await db.select().from(merchants).where(eq(merchants.name, name)))[0].id;

let bakery: string;
let cafe: string;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
  await addManual("Fernwood Bakery");
  await addManual("Fernwood Bakery Cafe");
  [bakery, cafe] = [await merchantId("Fernwood Bakery"), await merchantId("Fernwood Bakery Cafe")];
  await run("merchants.merge", { keepId: bakery, mergeId: cafe });
});

const createRule = async (pattern: string) =>
  ((await run("rules.create", { matchField: "merchant", matchType: "equals", pattern, categoryId: cat.Dining })).output as { id: string }).id;
const ruleRow = async (id: string) => (await db.select().from(rules).where(eq(rules.id, id)))[0];

describe("a merchant-is rule", () => {
  it("is for the merchant the pattern names, by any of its spellings, and matches all of them", async () => {
    const id = await createRule("fernwood bakery cafe");
    expect((await ruleRow(id)).merchantId).toBe(bakery);
    const later = await addManual("FERNWOOD BAKERY CAFE");
    await runCategorization(db);
    expect((await txn(later)).categoryId).toBe(cat.Dining);
    const [listed] = (await read(db, listRules, {})).filter((r) => r.id === id);
    expect(listed.merchantName).toBe("Fernwood Bakery");
  });

  it("follows a merge to the merchant kept, and back on undo", async () => {
    const [{ id: other }] = await db.insert(merchants).values({ name: "Juniper Hardware" }).returning();
    const id = await createRule("Juniper Hardware");
    expect((await ruleRow(id)).merchantId).toBe(other);
    const merged = await run("merchants.merge", { keepId: bakery, mergeId: other });
    expect((await ruleRow(id)).merchantId).toBe(bakery);
    await undoCommand(db, merged.commandId);
    expect((await ruleRow(id)).merchantId).toBe(other);
  });

  it("matches by text when no merchant has the name, and contains-rules are never tied to one", async () => {
    expect((await ruleRow(await createRule("Nobody By This Name"))).merchantId).toBeNull();
    const contains = await run("rules.create", { matchField: "merchant", matchType: "contains", pattern: "Fernwood", categoryId: cat.Dining });
    expect((await ruleRow((contains.output as { id: string }).id)).merchantId).toBeNull();
  });

  it("is worked out again when its pattern changes", async () => {
    const id = await createRule("Fernwood Bakery");
    await run("rules.update", { ruleId: id, pattern: "Nobody By This Name" });
    expect((await ruleRow(id)).merchantId).toBeNull();
  });

  it("previews its merchant, spellings and counts before it's saved", async () => {
    const preview = await read(db, matchPreview, { matchField: "merchant", matchType: "equals", pattern: "Fernwood Bakery Cafe" });
    expect(preview.merchant).toMatchObject({ id: bakery, name: "Fernwood Bakery", names: ["Fernwood Bakery", "Fernwood Bakery Cafe"] });
    expect(preview.transactions).toBe(2);
    expect(preview.uncategorized).toBeLessThanOrEqual(2);
    expect(await db.select().from(rules).where(eq(rules.pattern, "Fernwood Bakery Cafe"))).toHaveLength(0);
  });
});

describe("the migration", () => {
  it("ties existing merchant-is rules to the merchant they name and leaves the rest", async () => {
    const [is, other] = await db
      .insert(rules)
      .values([
        { matchField: "merchant", matchType: "equals", pattern: "FERNWOOD BAKERY CAFE", categoryId: cat.Dining },
        { matchField: "description", matchType: "equals", pattern: "Fernwood Bakery", categoryId: cat.Dining },
      ])
      .returning();
    const file = readFileSync("drizzle/0041_rules_merchant.sql", "utf8");
    await db.execute(sql.raw(file.slice(file.indexOf("UPDATE \"rules\""))));
    expect((await ruleRow(is.id)).merchantId).toBe(bakery);
    expect((await ruleRow(other.id)).merchantId).toBeNull();
  });
});

describe("merchant memory", () => {
  it("is per merchant: a new spelling is suggested what the other taught", async () => {
    await addManual("Fernwood Bakery", cat.Dining);
    const fresh = await addManual("Fernwood Bakery Cafe");
    const rows = await read(db, listInbox, {});
    const row = rows.find((r) => r.id === fresh);
    // Only if the account counts toward budgets; the seed's payment app does.
    expect(row).toBeDefined();
    expect(row).toMatchObject({ suggestedCategoryId: cat.Dining, suggestionSource: "memory" });
  });
});
