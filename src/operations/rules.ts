import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, commandLog, rules, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { categoryOptions } from "@/lib/categorize/labels";
import { firstMatchingRule } from "@/lib/categorize/match";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";

// The owner's categorization rules. Creating or editing one never
// recategorizes anything by itself; the pipeline applies rules to
// uncategorized transactions (src/lib/categorize/pipeline.ts), and the UI
// runs it right after a rule is saved. Reaching transactions that already
// have a category is a separate, owner-started re-apply (#100, below).

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

// --- Re-applying a rule to past transactions (#100) ----------------------------
//
// Rules only ever fill in uncategorized transactions, so a rule fixed later
// doesn't reach what it (or anything else) already filed. Re-applying is
// always the owner's doing, from a button, with a preview first: never on
// the nightly sync or a timer, which keep to uncategorized transactions.

// Actors whose category is the owner's own decision: their edits, and
// Tally's proposals they approved.
const OWNER_ACTORS = new Set(["user", "tally"]);

export type SkipReason = "set by you" | "no record of who set it" | "filed as a transfer";

/**
 * Who last set each transaction's category, from the command log: the
 * latest applied command whose change moved its category_id (an insert
 * with one counts). Undone commands and the undos themselves are left out,
 * so after an undo the category is credited to whoever set what it went
 * back to. Each comes with the category it left, so a caller can tell a
 * category changed since outside the log (no record) from one still as
 * that actor set it. Only ids come back from the database, not the rows'
 * snapshots.
 */
async function categorySetters(db: Db): Promise<Map<string, { actor: string; categoryId: string | null }>> {
  const rows = await db
    .select({
      actor: commandLog.actor,
      sets: sql<[string, string | null][]>`(
        select coalesce(jsonb_agg(jsonb_build_array(e->>'id', e->'after'->>'category_id')), '[]'::jsonb)
        from jsonb_array_elements(${commandLog.changes}) e
        where e->>'table' = 'transactions'
          and (e->'before'->>'category_id') is distinct from (e->'after'->>'category_id')
      )`,
    })
    .from(commandLog)
    .where(
      and(
        eq(commandLog.status, "applied"),
        isNull(commandLog.undoOf),
        isNull(commandLog.undoneBy),
        sql`${commandLog.changes} @> '[{"table":"transactions"}]'::jsonb`,
      ),
    )
    .orderBy(asc(commandLog.createdAt));
  const setBy = new Map<string, { actor: string; categoryId: string | null }>();
  for (const row of rows) for (const [id, categoryId] of row.sets) setBy.set(id, { actor: row.actor, categoryId });
  return setBy;
}

/**
 * Every categorized transaction whose category would change if the rules
 * ran over it today: the first enabled rule that matches (rules keep their
 * priority, so a higher one still wins) files it somewhere else. Limited to
 * one rule's changes when ruleId is given. Same scope as the pipeline:
 * budget accounts, not split, not one side of a paired transfer.
 */
async function reapplyChanges(db: Db, ruleId?: string) {
  const [ruleRows, txns, cats, setBy] = await Promise.all([
    db.select().from(rules).where(eq(rules.enabled, true)).orderBy(asc(rules.priority), asc(rules.createdAt)),
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.name,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          isNotNull(transactions.categoryId),
          eq(transactions.isSplit, false),
          isNull(transactions.transferPairId),
          inArray(transactions.accountId, budgetAccountIds(db)),
        ),
      ),
    db.select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind }).from(categories),
    categorySetters(db),
  ]);
  const labelOf = new Map(categoryOptions(cats).map((o) => [o.id, o.label]));
  const kindOf = new Map(cats.map((c) => [c.id, c.kind]));

  const changes = [];
  for (const t of txns) {
    const rule = firstMatchingRule(ruleRows, t);
    if (!rule || rule.categoryId === t.categoryId || (ruleId && rule.id !== ruleId)) continue;
    const logged = setBy.get(t.id);
    const actor = logged && logged.categoryId === t.categoryId ? logged.actor : null;
    // Left unticked unless the owner ticks it: their own choices, rows
    // with no record of who chose (data from before the log), and
    // transfers, which a rule would turn into spending counted twice.
    const skipReason: SkipReason | null =
      kindOf.get(t.categoryId!) === "transfer"
        ? "filed as a transfer"
        : actor === null
          ? "no record of who set it"
          : OWNER_ACTORS.has(actor)
            ? "set by you"
            : null;
    changes.push({
      ruleId: rule.id,
      transactionId: t.id,
      postedOn: t.postedOn,
      accountName: t.accountName,
      description: t.description,
      amountCents: t.amountCents,
      fromCategoryId: t.categoryId!,
      fromCategoryName: labelOf.get(t.categoryId!) ?? "Unknown category",
      toCategoryId: rule.categoryId,
      toCategoryName: labelOf.get(rule.categoryId) ?? "Unknown category",
      setBy: actor,
      skipReason,
    });
  }
  return changes.sort((a, b) => b.postedOn.localeCompare(a.postedOn));
}

export const reapplyPreview = defineRead({
  name: "rules.reapplyPreview",
  description:
    "What re-applying the rules to already-categorized transactions would change, without changing anything: each " +
    "transaction whose first matching enabled rule (in priority order) files it under a different category, with its " +
    "old and new category and the rule. ruleId limits it to one rule. skipReason marks rows left out unless the " +
    "owner includes them: set by the owner, no record of who set it, or filed as a transfer.",
  input: z.object({ ruleId: z.uuid().optional() }),
  run: (db, { ruleId }) => reapplyChanges(db, ruleId),
});

export const reapplyRule = defineWrite({
  name: "rules.reapply",
  description:
    "Re-apply one rule to the listed already-categorized transactions, from its preview: each still-matching one " +
    "gets the rule's category, as one undoable command. Rows no longer in the preview are left alone.",
  // The owner starts this from the preview; it rewrites their past
  // categories, so nothing else runs it.
  allowedActors: ["user"],
  input: z.object({ ruleId: z.uuid(), transactionIds: z.array(z.uuid()).min(1).max(5000) }),
  apply: async (ctx, { ruleId, transactionIds }) => {
    const [rule] = await ctx.db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, ruleId));
    if (!rule) throw new Error("Rule not found");
    if (!rule.enabled) throw new Error("Turn the rule on before re-applying it");
    // Worked out again here, so something that changed since the preview
    // (recategorized, split, paired) isn't overwritten from a stale list.
    const wanted = new Set(transactionIds);
    let applied = 0;
    for (const change of await reapplyChanges(ctx.db, ruleId)) {
      if (!wanted.has(change.transactionId)) continue;
      await ctx.update(transactions, change.transactionId, { categoryId: change.toCategoryId });
      applied++;
    }
    return { applied };
  },
});
