import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, merchantAliases, merchants, merchantTypes, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillMerchantsIfNeeded } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { listMerchants } from "@/operations/merchants";
import { execute, read, undoCommand } from "@/operations/runtime";

// Merchants as rows (#285), on the synthetic seed. Invented merchants and
// descriptions only.

let db: Db;
let p2p: string;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  [{ id: p2p }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "payment_app"));
});

type Out = { status: string; commandId: string; output: unknown };
const run = (operation: string, input: Record<string, unknown>, actor: "user" | "import" = "user") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<Out>;
const addManual = async (description: string) => {
  const r = await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -1_250, description });
  return (r.output as { transactionId: string }).transactionId;
};
const txn = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const merchantNamed = async (name: string) => (await db.select().from(merchants).where(eq(merchants.name, name)))[0];
const aliasesOf = async (merchantId: string) =>
  (await db.select({ alias: merchantAliases.alias }).from(merchantAliases).where(eq(merchantAliases.merchantId, merchantId))).map((a) => a.alias).sort();

describe("the backfill", () => {
  it("gives every transaction with a cleaned name a merchant, each name an alias of it", async () => {
    const unlinked = await db.select({ id: transactions.id }).from(transactions).where(and(isNotNull(transactions.merchant), isNull(transactions.merchantId)));
    expect(unlinked).toHaveLength(0);
    const [one] = await db.select().from(transactions).where(isNotNull(transactions.merchantId)).limit(1);
    const [alias] = await db.select().from(merchantAliases).where(eq(merchantAliases.alias, one.merchant!));
    expect(alias.merchantId).toBe(one.merchantId);
  });

  it("links on the nightly run anything that arrived without a merchant", async () => {
    const [row] = await db
      .insert(transactions)
      .values({ accountId: p2p, postedOn: "2026-06-21", amountCents: -500, description: "QUILLON TEA ROOM", merchant: "Quillon Tea Room", externalId: "old-code-1" })
      .returning();
    expect(row.merchantId).toBeNull();
    await backfillMerchantsIfNeeded(db);
    const linked = await txn(row.id);
    expect(linked.merchantId).toBe((await merchantNamed("Quillon Tea Room")).id);
  });
});

describe("on arrival", () => {
  it("links a new transaction to its merchant, making one on first sight; undo takes the new merchant away", async () => {
    const r = await run("transactions.createManual", { accountId: p2p, postedOn: "2026-06-20", amountCents: -900, description: "Marigold Noodle Bar" });
    const id = (r.output as { transactionId: string }).transactionId;
    const m = await merchantNamed("Marigold Noodle Bar");
    expect((await txn(id)).merchantId).toBe(m.id);
    expect(await aliasesOf(m.id)).toEqual(["Marigold Noodle Bar"]);
    await undoCommand(db, r.commandId);
    expect(await txn(id)).toBeUndefined();
    expect(await merchantNamed("Marigold Noodle Bar")).toBeUndefined();
  });

  it("joins a name it has seen before to the same merchant", async () => {
    const first = await addManual("Marigold Noodle Bar");
    const second = await addManual("MARIGOLD NOODLE BAR");
    expect((await txn(second)).merchantId).toBe((await txn(first)).merchantId);
  });
});

describe("the owner's operations", () => {
  let a: string;
  let b: string;
  let ta: string;
  let tb: string;
  beforeEach(async () => {
    ta = await addManual("Fernwood Bakery");
    tb = await addManual("Fernwood Bakery Cafe");
    a = (await merchantNamed("Fernwood Bakery")).id;
    b = (await merchantNamed("Fernwood Bakery Cafe")).id;
  });

  it("sets and clears a type, each undoable", async () => {
    const [cafe] = await db.select().from(merchantTypes).where(eq(merchantTypes.name, "Cafe"));
    const set = await run("merchants.setType", { merchantId: a, typeId: cafe.id });
    expect((await merchantNamed("Fernwood Bakery")).typeId).toBe(cafe.id);
    const cleared = await run("merchants.setType", { merchantId: a, typeId: null });
    expect((await merchantNamed("Fernwood Bakery")).typeId).toBeNull();
    await undoCommand(db, cleared.commandId);
    expect((await merchantNamed("Fernwood Bakery")).typeId).toBe(cafe.id);
    await undoCommand(db, set.commandId);
    expect((await merchantNamed("Fernwood Bakery")).typeId).toBeNull();
  });

  it("adds a type the built-in list doesn't have, once", async () => {
    await run("merchants.addType", { name: "Bike shop" });
    const types = await db.select().from(merchantTypes).where(eq(merchantTypes.name, "Bike shop"));
    expect(types).toMatchObject([{ builtIn: false }]);
    await expect(run("merchants.addType", { name: "bike SHOP" })).rejects.toThrow(/already a type/);
  });

  it("merges: aliases and transactions move to the one kept; undo restores both", async () => {
    const merged = await run("merchants.merge", { keepId: a, mergeId: b });
    expect(merged.output).toEqual({ aliases: 1, transactions: 1 });
    expect(await aliasesOf(a)).toEqual(["Fernwood Bakery", "Fernwood Bakery Cafe"]);
    expect((await txn(tb)).merchantId).toBe(a);
    expect(await merchantNamed("Fernwood Bakery Cafe")).toBeUndefined();
    // The cleaned name stays as it was: the alias is what carries the merge.
    expect((await txn(tb)).merchant).toBe("Fernwood Bakery Cafe");
    // And the next one under the merged spelling arrives at the merchant kept.
    expect((await txn(await addManual("Fernwood Bakery Cafe"))).merchantId).toBe(a);

    const [later] = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.merchant, "Fernwood Bakery Cafe"), ne(transactions.id, tb)));
    await undoCommand(db, merged.commandId);
    const back = await merchantNamed("Fernwood Bakery Cafe");
    expect(back.id).toBe(b);
    expect(await aliasesOf(b)).toEqual(["Fernwood Bakery Cafe"]);
    expect((await txn(tb)).merchantId).toBe(b);
    expect((await txn(ta)).merchantId).toBe(a);
    // The one that arrived after the merge followed its alias then; the nightly run follows it back.
    expect((await txn(later.id)).merchantId).toBe(a);
    await backfillMerchantsIfNeeded(db);
    expect((await txn(later.id)).merchantId).toBe(b);
  });

  it("splits an alias back out with its transactions, but never a merchant's only name", async () => {
    await run("merchants.merge", { keepId: a, mergeId: b });
    const [alias] = await db.select().from(merchantAliases).where(eq(merchantAliases.alias, "Fernwood Bakery Cafe"));
    const split = await run("merchants.splitAlias", { aliasId: alias.id });
    const out = await merchantNamed("Fernwood Bakery Cafe");
    expect((split.output as { merchantId: string }).merchantId).toBe(out.id);
    expect((await txn(tb)).merchantId).toBe(out.id);
    expect((await txn(ta)).merchantId).toBe(a);
    const [only] = await db.select().from(merchantAliases).where(eq(merchantAliases.alias, "Fernwood Bakery"));
    await expect(run("merchants.splitAlias", { aliasId: only.id })).rejects.toThrow(/only name/);
  });

  it("renames, but not onto another merchant's name, and creates by name", async () => {
    await run("merchants.rename", { merchantId: a, name: "Fernwood" });
    expect((await merchantNamed("Fernwood")).id).toBe(a);
    await expect(run("merchants.rename", { merchantId: a, name: "fernwood bakery cafe" })).rejects.toThrow(/merge the two/);
    const made = await run("merchants.create", { name: "Juniper Hardware" });
    const id = (made.output as { merchantId: string }).merchantId;
    expect(await aliasesOf(id)).toEqual(["Juniper Hardware"]);
  });

  it("lists merchants with their type, aliases and transaction counts", async () => {
    await run("merchants.merge", { keepId: a, mergeId: b });
    const list = (await read(db, listMerchants, {})) as { name: string; aliases: { alias: string }[]; transactions: number }[];
    expect(list.find((m) => m.name === "Fernwood Bakery")).toMatchObject({ transactions: 2, aliases: [{ alias: "Fernwood Bakery" }, { alias: "Fernwood Bakery Cafe" }] });
  });
});
