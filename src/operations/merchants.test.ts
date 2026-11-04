import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, merchantAliases, merchantMergeDismissals, merchants, merchantTypes, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { backfillMerchantsIfNeeded } from "@/lib/categorize/pipeline";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { mergeSuggestions } from "@/operations/merchant-views";
import { listMerchants, rederivePreviewRead } from "@/operations/merchants";
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
    expect(merged.output).toEqual({ merchantId: a, merged: 1, aliases: 1, transactions: 1 });
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

  it("merges under a chosen name, even the merged one's, in one undoable command (#304)", async () => {
    // Keep a ("Fernwood Bakery"), but call it what b was called.
    const merged = await run("merchants.merge", { keepId: a, mergeId: b, name: "Fernwood Bakery Cafe" });
    expect(await merchantNamed("Fernwood Bakery Cafe")).toMatchObject({ id: a });
    expect(await aliasesOf(a)).toEqual(["Fernwood Bakery", "Fernwood Bakery Cafe"]);
    await undoCommand(db, merged.commandId);
    expect(await merchantNamed("Fernwood Bakery")).toMatchObject({ id: a });
    expect(await merchantNamed("Fernwood Bakery Cafe")).toMatchObject({ id: b });
  });

  it("merges several into one under one name, and undoes as one (#304)", async () => {
    const tc = await addManual("Fernwood Bake Shop");
    const c = (await merchantNamed("Fernwood Bake Shop")).id;
    const merged = await run("merchants.merge", { keepId: b, mergeIds: [a, c], name: "Fernwood" });
    expect(merged.output).toMatchObject({ merchantId: b, merged: 2, transactions: 2 });
    expect(await aliasesOf(b)).toEqual(["Fernwood Bake Shop", "Fernwood Bakery", "Fernwood Bakery Cafe"]);
    for (const t of [ta, tb, tc]) expect((await txn(t)).merchantId).toBe(b);
    expect((await db.select().from(merchants).where(eq(merchants.id, a))).length).toBe(0);
    await undoCommand(db, merged.commandId);
    expect((await txn(ta)).merchantId).toBe(a);
    expect((await txn(tc)).merchantId).toBe(c);
    expect(await merchantNamed("Fernwood Bakery Cafe")).toMatchObject({ id: b });
  });

  it("refuses another merchant's name, merging nothing (#304)", async () => {
    await addManual("Juniper Hardware");
    await expect(run("merchants.merge", { keepId: a, mergeId: b, name: "juniper hardware" })).rejects.toThrow(/merge the two/);
    expect(await merchantNamed("Fernwood Bakery Cafe")).toMatchObject({ id: b });
    await expect(run("merchants.merge", { keepId: a, mergeIds: [b, a] })).rejects.toThrow(/two different/);
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

describe("merge suggestions (#287)", () => {
  const suggestions = () => read(db, mergeSuggestions, {});
  it("suggests a near-duplicate with names and descriptions only, and not again once rejected; undo brings it back", async () => {
    await addManual("Corner Bean");
    const [pair] = (await suggestions()).filter((s) => [s.a.name, s.b.name].includes("Corner Bean"));
    expect([pair.a.name, pair.b.name].sort()).toEqual(["Corner Bean", "Corner Bean Cafe"]);
    // What Tally would see: no amounts, accounts or ids beyond the merchants'.
    expect(Object.keys(pair.a).sort()).toEqual(["descriptions", "id", "name", "names"]);
    expect(pair.a.descriptions.length).toBeGreaterThan(0);

    const dismissed = await run("merchants.dismissMerge", { merchantId: pair.b.id, otherId: pair.a.id });
    expect((await suggestions()).some((s) => s.a.id === pair.a.id && s.b.id === pair.b.id)).toBe(false);
    await undoCommand(db, dismissed.commandId);
    expect((await suggestions()).some((s) => s.a.id === pair.a.id && s.b.id === pair.b.id)).toBe(true);
  });

  it("takes a merged merchant's rejections with it, and undo brings them back", async () => {
    await addManual("Corner Bean");
    await addManual("Corner Bean Cafe Downtown");
    const id = async (name: string) => (await merchantNamed(name)).id;
    const [bean, cafe, downtown] = [await id("Corner Bean"), await id("Corner Bean Cafe"), await id("Corner Bean Cafe Downtown")];
    await run("merchants.dismissMerge", { merchantId: bean, otherId: downtown });
    const merged = await run("merchants.merge", { keepId: cafe, mergeId: downtown });
    expect(await db.select().from(merchantMergeDismissals)).toHaveLength(0);
    await undoCommand(db, merged.commandId);
    expect(await db.select().from(merchantMergeDismissals)).toHaveLength(1);
  });
});

describe("re-running the cleanup (#288)", () => {
  // Rows as an older cleanup left them: named with the town still on.
  const stale = async (externalId: string, description: string, merchant: string, extra: Partial<typeof transactions.$inferInsert> = {}) =>
    (await db.insert(transactions).values({ accountId: p2p, postedOn: "2026-06-22", amountCents: -800, description, merchant, externalId, ...extra }).returning())[0];

  it("previews, then applies in one undoable change, keeping merges and pinned merchants", async () => {
    const a = await stale("s1", "HOLLOWAY BOOKS      SPRINGFIELD   IL", "Holloway Books Springfield Il");
    const b = await stale("s2", "HOLLOWAY BOOKS, RIVERTON, WA", "Holloway Books, Riverton, Wa");
    const pinned = await stale("s3", "HOLLOWAY BOOKS      SPRINGFIELD   IL", "Holloway Books Springfield Il", { merchantPinned: true });
    await backfillMerchantsIfNeeded(db);
    // The owner had merged the two town spellings under one merchant, and renamed it.
    const first = (await txn(a.id)).merchantId!;
    await run("merchants.merge", { keepId: first, mergeId: (await txn(b.id)).merchantId! });
    await run("merchants.rename", { merchantId: first, name: "Holloway Books" });

    const preview = await read(db, rederivePreviewRead, {});
    // One example per old spelling, both arriving at the same new name.
    const holloway = preview.examples.filter((e) => e.after === "Holloway Books");
    expect(holloway.map((e) => [e.before, e.transactions]).sort()).toEqual([
      ["Holloway Books Springfield Il", 1],
      ["Holloway Books, Riverton, Wa", 1],
    ]);
    expect(preview.pinned).toBe(1);
    expect(await txn(a.id)).toMatchObject({ merchant: "Holloway Books Springfield Il" });

    const applied = await run("merchants.rederive", {});
    expect(await txn(a.id)).toMatchObject({ merchant: "Holloway Books", merchantId: first });
    expect(await txn(b.id)).toMatchObject({ merchant: "Holloway Books", merchantId: first });
    expect(await txn(pinned.id)).toMatchObject({ merchant: "Holloway Books Springfield Il" });
    expect(await aliasesOf(first)).toContain("Holloway Books");
    // The raw description is never touched.
    expect((await txn(a.id)).description).toBe("HOLLOWAY BOOKS      SPRINGFIELD   IL");

    await undoCommand(db, applied.commandId);
    expect(await txn(a.id)).toMatchObject({ merchant: "Holloway Books Springfield Il", merchantId: first });
    expect(await aliasesOf(first)).not.toContain("Holloway Books");
  });
});
