import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { categories, commandLog, merchants, merchantTypes, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { chat } from "@/lib/model/client";
import { consistentCategory, MIN_CONFIDENCE, parseTypeReply, typeFromCategory, typeRequest, type TypeAnswer, type TypeOption } from "@/lib/merchants/types";
import { execute } from "@/operations/runtime";

// Proposing a type for each merchant that has none (#293): each is a
// proposed merchants.setType in Activity (and on the Merchants page) for
// the owner to approve or reject, never applied by itself. With
// onlyIfUnset, so approving one after the owner has set a type does nothing.
//
// First from a merchant's usual category, where it's filed consistently and
// the category says what kind of place it is; then, for the rest not asked
// before, the model, from names only. A merchant with a suggestion waiting,
// or one the owner rejected, isn't proposed again.

export type AskTypes = (types: TypeOption[], names: string[], options: { db: Db; deadline?: number }) => Promise<TypeAnswer[]>;

/** The real one: a model call through the gateway, names only. */
export const askModelForTypes: AskTypes = async (types, names, { db, deadline }) => {
  const { messages, jsonSchema } = typeRequest(types, names);
  const reply = await chat({ feature: "merchant-types", messages, jsonSchema, mode: "interactive", deadline, maxTokens: 48 * names.length + 256 }, { db });
  return parseTypeReply(reply.content, types, names.length);
};

const BATCH = 40;

export type TypeSuggestionResult = { fromCategory: number; fromModel: number; asked: number; error?: string };

export async function suggestMerchantTypes(
  db: Db,
  { ask = askModelForTypes, limit = 120, deadline, model = true }: { ask?: AskTypes; limit?: number; deadline?: number; model?: boolean } = {},
): Promise<TypeSuggestionResult> {
  const [untyped, types, answered] = await Promise.all([
    db.select({ id: merchants.id, name: merchants.name, askedAt: merchants.typeAskedAt }).from(merchants).where(isNull(merchants.typeId)),
    db.select({ id: merchantTypes.id, name: merchantTypes.name }).from(merchantTypes),
    // Waiting for the owner, or turned down by them: not proposed again.
    db
      .select({ merchantId: sql<string>`${commandLog.input}->>'merchantId'` })
      .from(commandLog)
      .where(and(eq(commandLog.operation, "merchants.setType"), inArray(commandLog.status, ["proposed", "rejected"]))),
  ]);
  const skip = new Set(answered.map((a) => a.merchantId));
  const open = untyped.filter((m) => !skip.has(m.id));
  if (open.length === 0 || types.length === 0) return { fromCategory: 0, fromModel: 0, asked: 0 };

  const propose = (merchantId: string, typeId: string, actor: "matcher" | "model", reason: string) =>
    execute(db, { operation: "merchants.setType", input: { merchantId, typeId, onlyIfUnset: true }, actor, reason, propose: true });
  const typeName = new Map(types.map((t) => [t.id, t.name]));

  // 1. From the usual category, deterministically.
  const filed = await db
    .select({ merchantId: transactions.merchantId, categoryId: transactions.categoryId, n: count() })
    .from(transactions)
    .where(and(inArray(transactions.merchantId, open.map((m) => m.id)), isNotNull(transactions.categoryId), eq(transactions.isSplit, false)))
    .groupBy(transactions.merchantId, transactions.categoryId);
  const cats = new Map((await db.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [c.id, c.name]));
  const byMerchant = new Map<string, { categoryId: string; n: number }[]>();
  for (const f of filed) byMerchant.set(f.merchantId!, [...(byMerchant.get(f.merchantId!) ?? []), { categoryId: f.categoryId!, n: f.n }]);
  const typeIds = new Map(types.map((t) => [t.name, t.id]));
  const placed = new Set<string>();
  for (const m of open) {
    const categoryId = consistentCategory(byMerchant.get(m.id) ?? []);
    const typeId = categoryId ? typeFromCategory(cats.get(categoryId) ?? "", typeIds) : null;
    if (!categoryId || !typeId) continue;
    await propose(m.id, typeId, "matcher", `Suggested type for ${m.name}: ${typeName.get(typeId)}, from its usual category, ${cats.get(categoryId)}`);
    placed.add(m.id);
  }

  // 2. The model, from names alone, for the rest it hasn't been asked about.
  const forModel = open.filter((m) => !placed.has(m.id) && !m.askedAt).slice(0, limit);
  if (!model || forModel.length === 0) return { fromCategory: placed.size, fromModel: 0, asked: 0 };
  let fromModel = 0;
  let asked = 0;
  let error: string | undefined;
  for (let i = 0; i < forModel.length; i += BATCH) {
    const batch = forModel.slice(i, i + BATCH);
    let answers: TypeAnswer[];
    try {
      answers = await ask(types, batch.map((m) => m.name), { db, deadline });
    } catch (e) {
      error = e instanceof Error ? e.message : "The model call failed";
      break;
    }
    for (const [j, m] of batch.entries()) {
      const a = answers[j];
      // Low confidence proposes nothing.
      if (!a.typeId || a.confidence < MIN_CONFIDENCE) continue;
      await propose(m.id, a.typeId, "model", `Suggested type for ${m.name}: ${typeName.get(a.typeId)}, from its name (${Math.round(a.confidence * 100)}% confident)`);
      fromModel++;
    }
    await execute(db, { operation: "merchants.recordTypeAsks", input: { merchantIds: batch.map((m) => m.id) }, actor: "model", reason: "Asked the model for merchant types" });
    asked += batch.length;
  }
  return { fromCategory: placed.size, fromModel, asked, ...(error ? { error } : {}) };
}

/** Type suggestions waiting for the owner, for the Merchants page. Newest first. */
export async function pendingTypeSuggestions(db: Db) {
  const rows = await db
    .select({ commandId: commandLog.id, actor: commandLog.actor, reason: commandLog.reason, merchantId: sql<string>`${commandLog.input}->>'merchantId'`, typeId: sql<string>`${commandLog.input}->>'typeId'` })
    .from(commandLog)
    .where(and(eq(commandLog.operation, "merchants.setType"), eq(commandLog.status, "proposed")))
    .orderBy(sql`${commandLog.createdAt} desc`);
  if (!rows.length) return [];
  const [names, types] = await Promise.all([
    db.select({ id: merchants.id, name: merchants.name, typeId: merchants.typeId }).from(merchants).where(inArray(merchants.id, rows.map((r) => r.merchantId))),
    db.select({ id: merchantTypes.id, name: merchantTypes.name }).from(merchantTypes),
  ]);
  const merchant = new Map(names.map((m) => [m.id, m]));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  // A merchant since merged away, or typed by the owner meanwhile, has nothing left to approve.
  return rows
    .filter((r) => merchant.get(r.merchantId) && !merchant.get(r.merchantId)!.typeId)
    .map((r) => ({
      commandId: r.commandId,
      merchantId: r.merchantId,
      merchantName: merchant.get(r.merchantId)!.name,
      typeName: typeName.get(r.typeId) ?? "a type since removed",
      source: r.actor === "model" ? ("name" as const) : ("category" as const),
      reason: r.reason,
    }));
}
