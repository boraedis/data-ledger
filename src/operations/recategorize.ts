import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accounts, budgetAdjustments, budgetTargets, categories, rules, transactionSplits, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { categoryOptions } from "@/lib/categorize/labels";
import { defineRead, defineWrite } from "@/operations/define";
import { removeSplits, transactionFilters } from "@/operations/transactions";

// Moving many transactions to one category at once (#116): a run filed
// under the wrong category, or everything in a category being replaced.
// Always a preview first (what changes, old and new, a total), then one
// undoable command as the owner. Re-applying rules to past transactions is
// #100's, in rules.ts; this is the owner choosing the category themselves.

// One preview, one command: enough for a category's whole history, and a
// size Activity and undo handle in one go.
export const MAX_MOVE = 2000;

const filter = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  accountId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const moveToCategoryPreview = defineRead({
  name: "transactions.moveToCategoryPreview",
  description:
    "What filing transactions under one category would change, without changing anything: the listed transactionIds, " +
    `or everything matching a filter (as transactions.list; up to ${MAX_MOVE}). Each row has its old and new category; ` +
    "split transactions are marked (moving one replaces its split). Already in that category, and one side of a paired " +
    "transfer (unpair it instead), are left out and counted.",
  input: z.object({ categoryId: z.uuid(), transactionIds: z.array(z.uuid()).min(1).max(MAX_MOVE).optional(), filter: filter.optional() }),
  run: async (db, { categoryId, transactionIds, filter: f }) => {
    if (!transactionIds && !f) throw new Error("Give transactions or a filter");
    const where = transactionIds ? [inArray(transactions.id, transactionIds)] : transactionFilters(db, f!);
    const [rows, cats] = await Promise.all([
      db
        .select({
          id: transactions.id,
          postedOn: transactions.postedOn,
          description: transactions.description,
          amountCents: transactions.amountCents,
          accountName: accounts.name,
          categoryId: transactions.categoryId,
          isSplit: transactions.isSplit,
          transferPairId: transactions.transferPairId,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(and(...where))
        .orderBy(desc(transactions.postedOn), transactions.id)
        // One over, to say there's more than a move can take.
        .limit(MAX_MOVE + 1),
      db.select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind }).from(categories),
    ]);
    const labelOf = new Map(categoryOptions(cats).map((o) => [o.id, o.label]));
    if (!labelOf.has(categoryId)) throw new Error("Category not found");

    const considered = rows.slice(0, MAX_MOVE);
    const paired = considered.filter((r) => r.transferPairId !== null);
    const already = considered.filter((r) => r.transferPairId === null && r.categoryId === categoryId && !r.isSplit);
    const changes = considered
      .filter((r) => r.transferPairId === null && (r.categoryId !== categoryId || r.isSplit))
      .map((r) => ({
        transactionId: r.id,
        postedOn: r.postedOn,
        accountName: r.accountName,
        description: r.description,
        amountCents: r.amountCents,
        fromCategoryName: r.isSplit ? "Split" : r.categoryId ? (labelOf.get(r.categoryId) ?? "Unknown category") : "Uncategorized",
        toCategoryName: labelOf.get(categoryId)!,
        // The owner divided it on purpose; one category would undo that.
        skipReason: r.isSplit ? "split across categories" : null,
      }));
    return {
      categoryName: labelOf.get(categoryId)!,
      changes,
      alreadyThere: already.length,
      pairedTransfers: paired.length,
      truncated: rows.length > MAX_MOVE,
    };
  },
});

/** Categories with nothing left that categories.delete would refuse over. */
async function unusedOf(db: Db, ids: string[]): Promise<string[]> {
  const unused: string[] = [];
  for (const id of ids) {
    const usage = await Promise.all([
      db.select({ value: count() }).from(transactions).where(eq(transactions.categoryId, id)),
      db.select({ value: count() }).from(transactionSplits).where(eq(transactionSplits.categoryId, id)),
      db.select({ value: count() }).from(rules).where(eq(rules.categoryId, id)),
      db.select({ value: count() }).from(categories).where(eq(categories.parentId, id)),
      db.select({ value: count() }).from(budgetTargets).where(eq(budgetTargets.categoryId, id)),
      db.select({ value: count() }).from(budgetAdjustments).where(eq(budgetAdjustments.categoryId, id)),
    ]);
    if (usage.every(([{ value }]) => value === 0)) unused.push(id);
  }
  return unused;
}

export const moveToCategory = defineWrite({
  name: "transactions.moveToCategory",
  description:
    "File the listed transactions under one category, from a moveToCategoryPreview the owner confirmed, as one undoable " +
    "command. A split transaction listed loses its split. Already there, or one side of a paired transfer, is left " +
    "alone. Returns how many moved and which of their old categories are now unused (and could be deleted).",
  // The owner's own recategorizing, picked row by row from a preview.
  allowedActors: ["user"],
  input: z.object({ categoryId: z.uuid(), transactionIds: z.array(z.uuid()).min(1).max(MAX_MOVE) }),
  apply: async (ctx, { categoryId, transactionIds }) => {
    const [target] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
    if (!target) throw new Error("Category not found");
    const rows = await ctx.db
      .select({ id: transactions.id, categoryId: transactions.categoryId, isSplit: transactions.isSplit, transferPairId: transactions.transferPairId })
      .from(transactions)
      .where(inArray(transactions.id, transactionIds));
    const splitParts = await ctx.db
      .select({ categoryId: transactionSplits.categoryId })
      .from(transactionSplits)
      .where(inArray(transactionSplits.transactionId, rows.filter((r) => r.isSplit).map((r) => r.id)));

    let moved = 0;
    const sources = new Set<string>();
    for (const row of rows) {
      if (row.transferPairId !== null || (row.categoryId === categoryId && !row.isSplit)) continue;
      if (row.categoryId) sources.add(row.categoryId);
      if (row.isSplit) await removeSplits(ctx, row.id);
      await ctx.update(transactions, row.id, { categoryId, isSplit: false });
      moved++;
    }
    for (const part of splitParts) if (part.categoryId) sources.add(part.categoryId);
    sources.delete(categoryId);
    return { moved, unusedCategoryIds: await unusedOf(ctx.db, [...sources]) };
  },
});
