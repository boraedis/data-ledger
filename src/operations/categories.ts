import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { categories, rules, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { defineRead, defineWrite } from "@/operations/define";

// The owner's category tree: top-level categories with optional children,
// two levels deep. Deep trees make every picker slower for no gain in a
// personal budget.

const name = z.string().trim().min(1).max(60);
const kind = z.enum(["expense", "income", "transfer"]);

async function assertNameFree(db: Db, parentId: string | null, candidate: string, exceptId?: string) {
  // Readable error up front; the unique (parent_id, name) constraint is the
  // real guard.
  const [clash] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId), eq(categories.name, candidate)));
  if (clash && clash.id !== exceptId) throw new Error(`"${candidate}" already exists there`);
}

async function assertValidParent(db: Db, parentId: string, childId?: string) {
  const [parent] = await db.select().from(categories).where(eq(categories.id, parentId));
  if (!parent) throw new Error("Parent category not found");
  if (parent.parentId) throw new Error("Categories nest one level deep; pick a top-level parent");
  if (childId && parentId === childId) throw new Error("A category can't be its own parent");
  if (childId) {
    const [{ value }] = await db.select({ value: count() }).from(categories).where(eq(categories.parentId, childId));
    if (value > 0) throw new Error("This category has its own subcategories, so it can't move under another one");
  }
  return parent;
}

export const listCategories = defineRead({
  name: "categories.list",
  description:
    "List all categories with kind (expense, income or transfer) and parentId (null for top-level). " +
    "Two levels: top-level categories and their subcategories.",
  input: z.object({}),
  run: (db) =>
    db
      .select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId })
      .from(categories)
      .orderBy(categories.name),
});

export const createCategory = defineWrite({
  name: "categories.create",
  description: "Create a category, optionally under a top-level parent. A subcategory takes its parent's kind.",
  input: z.object({ name, kind: kind.optional(), parentId: z.uuid().nullable().optional() }),
  apply: async (ctx, input) => {
    const parentId = input.parentId ?? null;
    let resolvedKind = input.kind;
    if (parentId) {
      const parent = await assertValidParent(ctx.db, parentId);
      // A child of "Income" being an expense would make totals incoherent.
      resolvedKind = parent.kind;
    }
    if (!resolvedKind) throw new Error("A top-level category needs a kind");
    await assertNameFree(ctx.db, parentId, input.name);
    return ctx.insert(categories, { name: input.name, kind: resolvedKind, parentId });
  },
});

export const renameCategory = defineWrite({
  name: "categories.rename",
  description: "Rename a category. Transactions and rules keep pointing at it; only the name changes.",
  input: z.object({ categoryId: z.uuid(), name }),
  apply: async (ctx, { categoryId, name }) => {
    const [current] = await ctx.db.select().from(categories).where(eq(categories.id, categoryId));
    if (!current) throw new Error("Category not found");
    await assertNameFree(ctx.db, current.parentId, name, categoryId);
    return ctx.update(categories, categoryId, { name });
  },
});

export const moveCategory = defineWrite({
  name: "categories.move",
  description: "Move a category under a top-level parent, or to the top level with parentId null.",
  input: z.object({ categoryId: z.uuid(), parentId: z.uuid().nullable() }),
  apply: async (ctx, { categoryId, parentId }) => {
    const [current] = await ctx.db.select().from(categories).where(eq(categories.id, categoryId));
    if (!current) throw new Error("Category not found");
    const set: Partial<typeof categories.$inferInsert> = { parentId };
    if (parentId) set.kind = (await assertValidParent(ctx.db, parentId, categoryId)).kind;
    await assertNameFree(ctx.db, parentId, current.name, categoryId);
    return ctx.update(categories, categoryId, set);
  },
});

export const deleteCategory = defineWrite({
  name: "categories.delete",
  description:
    "Delete a category that nothing uses: no transactions, rules or subcategories. " +
    "Recategorize or move those first.",
  input: z.object({ categoryId: z.uuid() }),
  apply: async (ctx, { categoryId }) => {
    // Refusing beats cascading: a delete that silently uncategorized
    // hundreds of transactions (a DB-side effect undo couldn't see) would be
    // the worst kind of surprise.
    const usage = await Promise.all([
      ctx.db.select({ value: count() }).from(transactions).where(eq(transactions.categoryId, categoryId)),
      ctx.db.select({ value: count() }).from(rules).where(eq(rules.categoryId, categoryId)),
      ctx.db.select({ value: count() }).from(categories).where(eq(categories.parentId, categoryId)),
    ]);
    const [txns, ruleCount, children] = usage.map(([{ value }]) => value);
    if (txns || ruleCount || children) {
      throw new Error(
        `Still in use: ${txns} transactions, ${ruleCount} rules, ${children} subcategories. Recategorize or move them first.`,
      );
    }
    await ctx.remove(categories, categoryId);
  },
});
