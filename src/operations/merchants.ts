import { and, asc, count, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { alerts, merchantAliases, merchantMergeDismissals, merchants, merchantTypes, recurringSeries, rules, transactions } from "@/db/schema";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { rederive, rederivePreview } from "@/lib/merchants/rederive";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Merchants (#285): a merchant is a row with aliases, and a transaction
// points at it. See the schema for the model. The raw bank fields are never
// touched; everything here moves links between rows, each as a tracked
// write, so every operation is undone by the runtime like any other.
//
// Links are made on arrival (merchantFields, from every path that adds a
// transaction) and by the nightly merchant backfill for anything that came
// in without one. Nothing here merges on its own: suggesting merges is a
// later issue, and the owner approves them (#284).

const merchantName = z.string().trim().min(1).max(80);

/**
 * A transaction's merchant as every feature shows it (#292): the linked
 * merchant's current name, so every spelling reads as one merchant. The
 * cleaned name only for one not linked yet (the nightly run links it).
 * Spending and the budget breakdowns group by it (names are unique).
 * Recurring charges and the suspicious-charge checks only show it: they
 * group, and store the owner's decisions, by merchant id (merchantKey in
 * lib/recurring and lib/suspicious), so a rename changes nothing stored.
 */
// Written out with the tables named: drizzle leaves columns unqualified in a
// one-table select, and an unqualified "id" or "name" here would be ambiguous.
export const canonicalMerchant = sql<string | null>`coalesce((select m."name" from "merchants" m where m."id" = "transactions"."merchant_id"), "transactions"."merchant")`;

/** A transaction's merchant's type, by name (#293), or null: for grouping Spending by type. */
export const merchantTypeName = sql<string | null>`(select mt."name" from "merchants" m join "merchant_types" mt on mt."id" = m."type_id" where m."id" = "transactions"."merchant_id")`;

// One import can bring hundreds of rows with the same few merchants: the
// lookups are remembered for the life of the write.
const seen = new WeakMap<WriteContext, Map<string, string>>();

/**
 * The merchant a cleaned name belongs to: its alias's merchant, else a
 * merchant already called that (the name gains the alias), else a new
 * merchant with it as its first alias. Tracked, so undoing the write that
 * first saw a name takes the merchant it made with it.
 */
export async function merchantFor(ctx: WriteContext, name: string | null): Promise<string | null> {
  if (!name) return null;
  const cache = seen.get(ctx) ?? new Map<string, string>();
  seen.set(ctx, cache);
  const known = cache.get(name);
  if (known) return known;
  const [alias] = await ctx.db.select({ merchantId: merchantAliases.merchantId }).from(merchantAliases).where(eq(merchantAliases.alias, name));
  let id = alias?.merchantId;
  if (!id) {
    const [named] = await ctx.db.select({ id: merchants.id }).from(merchants).where(sql`lower(${merchants.name}) = lower(${name})`);
    id = named?.id ?? (await ctx.insert(merchants, { name })).id;
    await ctx.insert(merchantAliases, { alias: name, merchantId: id });
  }
  cache.set(name, id);
  return id;
}

/** A transaction's derived merchant fields, from its raw ones: the cleaned name and the merchant it belongs to. */
export async function merchantFields(ctx: WriteContext, description: string, payee: string | null = null) {
  const merchant = normalizeMerchant(description, payee);
  return { merchant, merchantId: await merchantFor(ctx, merchant) };
}

/**
 * A merged merchant's recurring decisions and alerts (#292) become the
 * kept one's, with the alerts' dedupe keys (which name the merchant by id),
 * so an alert already answered isn't raised again. A decision the kept
 * merchant already has for the same account wins and the other goes.
 * Tracked writes, so undoing the merge puts them back. A rename needs
 * nothing: they're stored by id.
 */
async function moveDecisions(ctx: WriteContext, from: string, to: string) {
  const series = await ctx.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, from));
  for (const row of series) {
    const [taken] = await ctx.db
      .select({ id: recurringSeries.id })
      .from(recurringSeries)
      .where(and(eq(recurringSeries.merchantId, to), eq(recurringSeries.accountId, row.accountId)));
    if (taken) await ctx.remove(recurringSeries, row.id);
    else await ctx.update(recurringSeries, row.id, { merchantId: to });
  }
  const flagged = await ctx.db.select({ id: alerts.id, dedupeKey: alerts.dedupeKey }).from(alerts).where(eq(alerts.merchantId, from));
  for (const row of flagged) {
    const key = row.dedupeKey.split(`|${from}|`).join(`|${to}|`);
    const [clash] = key === row.dedupeKey ? [] : await ctx.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.dedupeKey, key));
    await ctx.update(alerts, row.id, clash ? { merchantId: to } : { merchantId: to, dedupeKey: key });
  }
}

async function getMerchant(ctx: WriteContext, id: string) {
  const [row] = await ctx.db.select().from(merchants).where(eq(merchants.id, id));
  if (!row) throw new NotFoundError("Merchant not found");
  return row;
}

async function assertNameFree(ctx: WriteContext, name: string, except?: string) {
  const [clash] = await ctx.db
    .select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(and(sql`lower(${merchants.name}) = lower(${name})`, except ? ne(merchants.id, except) : undefined));
  if (clash) throw new Error(`A merchant named "${clash.name}" already exists: merge the two instead`);
}

/** Moves every transaction linked to `from` over to `to`, one tracked write each, so undo puts each back. */
async function moveLinks(ctx: WriteContext, where: SQL | undefined, to: string) {
  const rows = await ctx.db.select({ id: transactions.id }).from(transactions).where(where);
  for (const r of rows) await ctx.update(transactions, r.id, { merchantId: to });
  return rows.length;
}

export const listMerchants = defineRead({
  name: "merchants.list",
  description: "List merchants: each one's name, type, the cleaned names (aliases) that belong to it, and how many transactions it has.",
  input: z.object({}),
  run: async (db) => {
    const [rows, aliases, counts] = await Promise.all([
      db
        .select({ id: merchants.id, name: merchants.name, typeId: merchants.typeId, type: merchantTypes.name })
        .from(merchants)
        .leftJoin(merchantTypes, eq(merchantTypes.id, merchants.typeId))
        .orderBy(asc(merchants.name)),
      db.select({ id: merchantAliases.id, alias: merchantAliases.alias, merchantId: merchantAliases.merchantId }).from(merchantAliases).orderBy(asc(merchantAliases.alias)),
      db.select({ merchantId: transactions.merchantId, n: count() }).from(transactions).where(isNotNull(transactions.merchantId)).groupBy(transactions.merchantId),
    ]);
    const n = new Map(counts.map((c) => [c.merchantId, c.n]));
    return rows.map((m) => ({
      ...m,
      aliases: aliases.filter((a) => a.merchantId === m.id).map((a) => ({ id: a.id, alias: a.alias })),
      transactions: n.get(m.id) ?? 0,
    }));
  },
});

export const listMerchantTypes = defineRead({
  name: "merchants.types",
  description: "List the merchant types a merchant can have (restaurant, grocery, gas station…), built-in and the owner's own.",
  input: z.object({}),
  run: (db) => db.select({ id: merchantTypes.id, name: merchantTypes.name, builtIn: merchantTypes.builtIn }).from(merchantTypes).orderBy(asc(merchantTypes.name)),
});

export const createMerchant = defineWrite({
  name: "merchants.create",
  description: "Create a merchant by name. Its name becomes its first alias unless another merchant already has it.",
  input: z.object({ name: merchantName }),
  apply: async (ctx, { name }) => {
    await assertNameFree(ctx, name);
    const row = await ctx.insert(merchants, { name });
    const [taken] = await ctx.db.select({ id: merchantAliases.id }).from(merchantAliases).where(eq(merchantAliases.alias, name));
    if (!taken) await ctx.insert(merchantAliases, { alias: name, merchantId: row.id });
    return { merchantId: row.id };
  },
});

export const renameMerchant = defineWrite({
  name: "merchants.rename",
  description: "Rename a merchant everywhere it's shown. Its aliases (the cleaned names that belong to it) stay as they are.",
  input: z.object({ merchantId: z.uuid(), name: merchantName }),
  apply: async (ctx, { merchantId, name }) => {
    await getMerchant(ctx, merchantId);
    await assertNameFree(ctx, name, merchantId);
    return ctx.update(merchants, merchantId, { name });
  },
});

export const mergeMerchants = defineWrite({
  name: "merchants.merge",
  description:
    "Merge one merchant into another: its aliases and transactions move to the one kept, which keeps its own name, " +
    "and takes the other's type if it has none. The merged merchant is removed.",
  input: z.object({ keepId: z.uuid(), mergeId: z.uuid() }),
  apply: async (ctx, { keepId, mergeId }) => {
    if (keepId === mergeId) throw new Error("Pick two different merchants to merge");
    const keep = await getMerchant(ctx, keepId);
    const gone = await getMerchant(ctx, mergeId);
    const aliases = await ctx.db.select({ id: merchantAliases.id }).from(merchantAliases).where(eq(merchantAliases.merchantId, mergeId));
    for (const a of aliases) await ctx.update(merchantAliases, a.id, { merchantId: keepId });
    const moved = await moveLinks(ctx, eq(transactions.merchantId, mergeId), keepId);
    if (!keep.typeId && gone.typeId) await ctx.update(merchants, keepId, { typeId: gone.typeId });
    // Its rules (#289) now apply to the one kept, every spelling included.
    const merchantRules = await ctx.db.select({ id: rules.id }).from(rules).where(eq(rules.merchantId, mergeId));
    for (const r of merchantRules) await ctx.update(rules, r.id, { merchantId: keepId });
    // Its rejected pairs (#287) go with it, as tracked writes rather than the
    // FK cascade, so undoing the merge brings them back too.
    const dismissals = await ctx.db
      .select({ id: merchantMergeDismissals.id })
      .from(merchantMergeDismissals)
      .where(or(eq(merchantMergeDismissals.merchantAId, mergeId), eq(merchantMergeDismissals.merchantBId, mergeId)));
    for (const d of dismissals) await ctx.remove(merchantMergeDismissals, d.id);
    // Its recurring decisions and alerts now the kept one's (#292), before
    // it goes: the FK would otherwise just clear them.
    await moveDecisions(ctx, mergeId, keepId);
    await ctx.remove(merchants, mergeId);
    return { aliases: aliases.length, transactions: moved };
  },
});

export const dismissMerge = defineWrite({
  name: "merchants.dismissMerge",
  description: "Say two merchants aren't the same business, so they aren't suggested for merging again.",
  input: z.object({ merchantId: z.uuid(), otherId: z.uuid() }),
  apply: async (ctx, { merchantId, otherId }) => {
    if (merchantId === otherId) throw new Error("Pick two different merchants");
    await getMerchant(ctx, merchantId);
    await getMerchant(ctx, otherId);
    const [a, b] = merchantId < otherId ? [merchantId, otherId] : [otherId, merchantId];
    const [already] = await ctx.db
      .select({ id: merchantMergeDismissals.id })
      .from(merchantMergeDismissals)
      .where(and(eq(merchantMergeDismissals.merchantAId, a), eq(merchantMergeDismissals.merchantBId, b)));
    if (already) return { dismissalId: already.id };
    const row = await ctx.insert(merchantMergeDismissals, { merchantAId: a, merchantBId: b });
    return { dismissalId: row.id };
  },
});

export const splitAlias = defineWrite({
  name: "merchants.splitAlias",
  description:
    "Split a cleaned name (an alias) back out of its merchant into a merchant of its own, named after it, with the " +
    "transactions under that name. A merchant's only alias can't be split out.",
  input: z.object({ aliasId: z.uuid() }),
  apply: async (ctx, { aliasId }) => {
    const [alias] = await ctx.db.select().from(merchantAliases).where(eq(merchantAliases.id, aliasId));
    if (!alias) throw new NotFoundError("Alias not found");
    const [{ n }] = await ctx.db.select({ n: count() }).from(merchantAliases).where(eq(merchantAliases.merchantId, alias.merchantId));
    if (n < 2) throw new Error("That's the merchant's only name; rename the merchant instead");
    await assertNameFree(ctx, alias.alias);
    const row = await ctx.insert(merchants, { name: alias.alias });
    await ctx.update(merchantAliases, aliasId, { merchantId: row.id });
    // Ones the owner put here by hand (#291) stay here.
    const moved = await moveLinks(
      ctx,
      and(eq(transactions.merchantId, alias.merchantId), eq(transactions.merchant, alias.alias), eq(transactions.merchantPinned, false)),
      row.id,
    );
    return { merchantId: row.id, transactions: moved };
  },
});

export const setMerchantType = defineWrite({
  name: "merchants.setType",
  description:
    "Set a merchant's type (restaurant, grocery, gas station…) from the list, or clear it with null. Every alias " +
    "shares it. With onlyIfUnset, as a suggestion is, it does nothing to a merchant that already has a type.",
  input: z.object({ merchantId: z.uuid(), typeId: z.uuid().nullable(), onlyIfUnset: z.boolean().default(false) }),
  apply: async (ctx, { merchantId, typeId, onlyIfUnset }) => {
    const current = await getMerchant(ctx, merchantId);
    // A suggestion approved after the owner set a type themselves (#293)
    // never overwrites it.
    if (onlyIfUnset && current.typeId) throw new Error("That merchant already has a type; the suggestion wasn't applied");
    if (typeId) {
      const [type] = await ctx.db.select({ id: merchantTypes.id }).from(merchantTypes).where(eq(merchantTypes.id, typeId));
      if (!type) throw new NotFoundError("Merchant type not found");
    }
    return ctx.update(merchants, merchantId, { typeId });
  },
});

export const addMerchantType = defineWrite({
  name: "merchants.addType",
  description: "Add a merchant type to the list, for a kind of merchant the built-in ones don't cover.",
  input: z.object({ name: z.string().trim().min(1).max(40) }),
  apply: async (ctx, { name }) => {
    const [clash] = await ctx.db.select({ name: merchantTypes.name }).from(merchantTypes).where(sql`lower(${merchantTypes.name}) = lower(${name})`);
    if (clash) throw new Error(`"${clash.name}" is already a type`);
    const row = await ctx.insert(merchantTypes, { name });
    return { typeId: row.id };
  },
});

/**
 * Transactions whose link doesn't agree with their cleaned name's alias:
 * none yet (from before merchants were rows, or added by older code during
 * a deploy), or one a later write left behind (one that arrived after a
 * merge that was then undone). The alias is the truth.
 */
export const misLinked = and(
  // A merchant the owner chose by hand (#291) is meant to disagree.
  eq(transactions.merchantPinned, false),
  isNotNull(transactions.merchant),
  ne(transactions.merchant, ""),
  or(
    isNull(transactions.merchantId),
    sql`${transactions.merchantId} is distinct from (select ${merchantAliases.merchantId} from ${merchantAliases} where ${merchantAliases.alias} = ${transactions.merchant})`,
  ),
);

/** Links up to `limit` mis-linked transactions to their alias's merchant; for the nightly backfill. */
export async function linkUnlinked(ctx: WriteContext, limit: number): Promise<number> {
  const rows = await ctx.db.select({ id: transactions.id, merchant: transactions.merchant }).from(transactions).where(misLinked).limit(limit);
  for (const r of rows) await ctx.update(transactions, r.id, { merchantId: await merchantFor(ctx, r.merchant) });
  return rows.length;
}


// --- Re-running the cleanup over history (#288) ----------------------------

async function rederiveInputs(db: WriteContext["db"]) {
  const [rows, ruleRows, series] = await Promise.all([
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        description: transactions.description,
        payee: transactions.payee,
        merchant: transactions.merchant,
        merchantId: transactions.merchantId,
        pinned: transactions.merchantPinned,
      })
      .from(transactions),
    db.select().from(rules),
    db.select({ merchant: recurringSeries.merchant, status: recurringSeries.status }).from(recurringSeries),
  ]);
  return { rows, rules: ruleRows, series };
}

export const rederivePreviewRead = defineRead({
  name: "merchants.rederivePreview",
  description:
    "Preview re-running the merchant name cleanup over every transaction: how many would get a different merchant " +
    "name, examples (before and after), merchant rules whose matches would change, and recurring decisions on names " +
    "that would go away. Transactions whose merchant was chosen by hand are left alone. Changes nothing.",
  allowedActors: ["user"],
  input: z.object({}),
  run: async (db) => {
    const { rows, rules: ruleRows, series } = await rederiveInputs(db);
    return rederivePreview(rows, { rules: ruleRows, series });
  },
});

export const rederiveMerchants = defineWrite({
  name: "merchants.rederive",
  description:
    "Re-run the merchant name cleanup over every transaction, as merchants.rederivePreview showed, in one undoable " +
    "change. A new name joins the merchant it's already a name of, else the merchant the transaction's old name " +
    "belonged to (so merges stay), else a new one. Transactions whose merchant was chosen by hand are left alone.",
  allowedActors: ["user"],
  input: z.object({}),
  apply: async (ctx) => {
    const { rows } = await rederiveInputs(ctx.db);
    const changes = rederive(rows);
    const oldMerchant = new Map(rows.map((r) => [r.id, r.merchantId]));
    const joined = new Map<string, string>();
    for (const c of changes) {
      let merchantId = joined.get(c.after);
      if (!merchantId) {
        const [alias] = await ctx.db.select({ merchantId: merchantAliases.merchantId }).from(merchantAliases).where(eq(merchantAliases.alias, c.after));
        const old = oldMerchant.get(c.id);
        if (alias) merchantId = alias.merchantId;
        else if (old) merchantId = (await ctx.insert(merchantAliases, { alias: c.after, merchantId: old })).merchantId;
        else merchantId = (await merchantFor(ctx, c.after))!;
        joined.set(c.after, merchantId);
      }
      await ctx.update(transactions, c.id, { merchant: c.after, merchantId });
    }
    return { changed: changes.length };
  },
});

// --- Fixing one transaction's merchant by hand (#291) ---------------------
//
// "This is actually …": the transaction (and, if asked, the others with the
// same raw description) gets the merchant the owner picked, and is pinned
// there. Its cleaned name stays what the bank's text gives, so the page can
// still explain it (#290); the pin is what keeps the nightly relink, a
// cleanup re-run and splitting a spelling out from moving it back. Merging
// the merchant it's pinned to still carries it along, to the one kept.

/** The others with the same raw description, not counting ones already pinned elsewhere. */
async function similarTo(db: WriteContext["db"], transactionId: string) {
  const [txn] = await db.select({ description: transactions.description }).from(transactions).where(eq(transactions.id, transactionId));
  if (!txn) throw new NotFoundError("Transaction not found");
  const rows = await db
    .select({ id: transactions.id, pinned: transactions.merchantPinned })
    .from(transactions)
    .where(and(eq(transactions.description, txn.description), ne(transactions.id, transactionId)));
  return { description: txn.description, ids: rows.filter((r) => !r.pinned).map((r) => r.id), pinned: rows.filter((r) => r.pinned).length };
}

export const similarTransactions = defineRead({
  name: "merchants.similarTransactions",
  description:
    "Before fixing a transaction's merchant: how many other transactions have exactly the same bank description " +
    "(and so would change too with similar: true), and how many of those already have a merchant chosen by hand.",
  input: z.object({ transactionId: z.uuid() }),
  run: async (db, { transactionId }) => {
    const { ids, pinned } = await similarTo(db, transactionId);
    return { transactions: ids.length, alreadyChosen: pinned };
  },
});

export const setTransactionMerchant = defineWrite({
  name: "merchants.setForTransaction",
  description:
    "Fix a transaction's merchant by hand: the merchant given by id, or by name (an existing one called that, else " +
    "a new one). With similar: true, every other transaction with exactly the same bank description changes too, " +
    "except ones whose merchant was already chosen by hand. Each is pinned, so cleanups and relinking leave it alone.",
  input: z.object({ transactionId: z.uuid(), merchantId: z.uuid().optional(), name: merchantName.optional(), similar: z.boolean().default(false) }),
  apply: async (ctx, { transactionId, merchantId, name, similar }) => {
    if (!merchantId === !name) throw new Error("Pick a merchant or give a new one's name");
    let target = merchantId;
    if (target) await getMerchant(ctx, target);
    else {
      const [named] = await ctx.db.select({ id: merchants.id }).from(merchants).where(sql`lower(${merchants.name}) = lower(${name!})`);
      target = named?.id ?? (await ctx.insert(merchants, { name: name! })).id;
    }
    const others = similar ? (await similarTo(ctx.db, transactionId)).ids : [];
    for (const id of [transactionId, ...others]) await ctx.update(transactions, id, { merchantId: target, merchantPinned: true });
    return { merchantId: target, transactions: 1 + others.length };
  },
});

export const unpinTransactionMerchant = defineWrite({
  name: "merchants.unpinTransaction",
  description: "Undo a hand-chosen merchant on one transaction: it goes back to the merchant its cleaned name belongs to.",
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const [txn] = await ctx.db.select({ merchant: transactions.merchant }).from(transactions).where(eq(transactions.id, transactionId));
    if (!txn) throw new NotFoundError("Transaction not found");
    const merchantId = await merchantFor(ctx, txn.merchant);
    await ctx.update(transactions, transactionId, { merchantId, merchantPinned: false });
    return { merchantId };
  },
});

export const recordTypeAsks = defineWrite({
  name: "merchants.recordTypeAsks",
  description: "Pipeline only: note that the model was asked for these merchants' types (#293), so they aren't sent again.",
  allowedActors: ["model", "user"],
  input: z.object({ merchantIds: z.array(z.uuid()).min(1).max(500) }),
  apply: async (ctx, { merchantIds }) => {
    const at = new Date();
    for (const id of merchantIds) await ctx.update(merchants, id, { typeAskedAt: at });
    return { recorded: merchantIds.length };
  },
});
