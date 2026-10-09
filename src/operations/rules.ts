import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { categories, rules } from "@/db/schema";
import { defineRead, defineWrite } from "@/operations/define";

// The owner's categorization rules. Creating or editing one never
// recategorizes anything by itself; the pipeline applies rules to
// uncategorized transactions (src/lib/categorize/pipeline.ts), and the UI
// runs it right after a rule is saved.

const ruleFields = z.object({
  matchField: z.enum(["merchant", "description"]),
  matchType: z.enum(["equals", "contains", "starts_with"]),
  pattern: z.string().trim().min(2).max(100),
  accountId: z.uuid().nullable().optional(),
  minAmountCents: z.number().int().min(0).nullable().optional(),
  maxAmountCents: z.number().int().min(0).nullable().optional(),
  categoryId: z.uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
});

function assertRange(min?: number | null, max?: number | null) {
  if (min != null && max != null && min > max) throw new Error("Minimum amount is above the maximum");
}

export const listRules = defineRead({
  name: "rules.list",
  description: "List categorization rules in the order they run (priority, then age).",
  input: z.object({}),
  run: (db) =>
    db
      .select({ rule: rules, categoryName: categories.name })
      .from(rules)
      .innerJoin(categories, eq(categories.id, rules.categoryId))
      .orderBy(asc(rules.priority), asc(rules.createdAt))
      .then((rows) => rows.map(({ rule, categoryName }) => ({ ...rule, categoryName }))),
});

export const createRule = defineWrite({
  name: "rules.create",
  description:
    "Create a rule: transactions whose merchant or description equals / contains / starts with the pattern " +
    "(case-insensitive), optionally limited to one account or an amount range, get this category.",
  input: ruleFields,
  apply: async (ctx, input) => {
    assertRange(input.minAmountCents, input.maxAmountCents);
    return ctx.insert(rules, input);
  },
});

export const updateRule = defineWrite({
  name: "rules.update",
  description: "Change a rule's pattern, category, limits, priority, or enable/disable it.",
  input: ruleFields.partial().extend({ ruleId: z.uuid() }),
  apply: async (ctx, { ruleId, ...changes }) => {
    const [current] = await ctx.db.select().from(rules).where(eq(rules.id, ruleId));
    if (!current) throw new Error("Rule not found");
    assertRange(changes.minAmountCents ?? current.minAmountCents, changes.maxAmountCents ?? current.maxAmountCents);
    if (Object.keys(changes).length === 0) throw new Error("Nothing to change");
    return ctx.update(rules, ruleId, changes);
  },
});

export const deleteRule = defineWrite({
  name: "rules.delete",
  description: "Delete a rule. Transactions it already categorized keep their category.",
  input: z.object({ ruleId: z.uuid() }),
  apply: (ctx, { ruleId }) => ctx.remove(rules, ruleId),
});
