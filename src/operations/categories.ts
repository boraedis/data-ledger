import { eq } from "drizzle-orm";
import { z } from "zod";
import { categories } from "@/db/schema";
import { defineRead, defineWrite } from "@/operations/define";

const name = z.string().trim().min(1).max(60);

export const listCategories = defineRead({
  name: "categories.list",
  description: "List all categories with their kind (expense, income or transfer).",
  input: z.object({}),
  run: (db) => db.select().from(categories).orderBy(categories.name),
});

export const createCategory = defineWrite({
  name: "categories.create",
  description: "Create a new category. Names are unique.",
  input: z.object({ name, kind: z.enum(["expense", "income", "transfer"]) }),
  apply: (ctx, input) => ctx.insert(categories, input),
});

export const renameCategory = defineWrite({
  name: "categories.rename",
  description: "Rename an existing category. Transactions keep their category; only the name changes.",
  input: z.object({ categoryId: z.uuid(), name }),
  apply: async (ctx, { categoryId, name }) => {
    // Checked here for a readable error; the unique index is the real guard.
    const [clash] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
    if (clash && clash.id !== categoryId) throw new Error(`A category named "${name}" already exists`);
    return ctx.update(categories, categoryId, { name });
  },
});
