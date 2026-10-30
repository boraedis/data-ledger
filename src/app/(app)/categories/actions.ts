"use server";

import { revalidatePath } from "next/cache";
import { runCategorization } from "@/lib/categorize/pipeline";
import { execute } from "@/operations/runtime";
import { asOwner, executeAsOwner } from "@/operations/server";

type Result = { error: string } | { ok: true; message?: string };

// Each edit is one operation as the owner (validated, logged, undoable).
// Rule edits re-run the pipeline so a new or re-enabled rule takes effect
// on what's already waiting in the inbox.
async function run(operation: string, input: Record<string, unknown>, reason: string, { recategorize = false } = {}): Promise<Result> {
  try {
    const message = await asOwner(async (db) => {
      await execute(db, { operation, input, actor: "user", reason });
      if (!recategorize) return undefined;
      const result = await runCategorization(db);
      const n = result.byRules;
      return n ? `${n} transactions categorized` : undefined;
    });
    revalidatePath("/categories");
    revalidatePath("/inbox");
    return { ok: true, message };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function createCategory(name: string, parentId: string | null, kind: string) {
  return run("categories.create", parentId ? { name, parentId } : { name, kind }, `Created category "${name}"`);
}

export async function renameCategory(categoryId: string, name: string) {
  return run("categories.rename", { categoryId, name }, `Renamed category to "${name}"`);
}

export async function moveCategory(categoryId: string, parentId: string | null) {
  return run("categories.move", { categoryId, parentId }, parentId ? "Moved category under a parent" : "Moved category to the top level");
}

export async function deleteCategory(categoryId: string) {
  return run("categories.delete", { categoryId }, "Deleted category");
}

export async function setRuleEnabled(ruleId: string, enabled: boolean) {
  return run("rules.update", { ruleId, enabled }, enabled ? "Enabled rule" : "Disabled rule", { recategorize: enabled });
}

export async function deleteRule(ruleId: string) {
  return run("rules.delete", { ruleId }, "Deleted rule");
}

export async function createRule(input: { matchField: string; matchType: string; pattern: string; categoryId: string }) {
  return run("rules.create", input, `Created rule for "${input.pattern}"`, { recategorize: true });
}

export async function runRulesNow(): Promise<Result> {
  try {
    const result = await asOwner((db) => runCategorization(db));
    revalidatePath("/inbox");
    return { ok: true, message: `${result.byRules} categorized by rules, ${result.remaining} left in the inbox to confirm` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

// Re-applying a rule to transactions that already have a category (#100):
// only the rows the owner left ticked in the preview, as one undoable
// command.
export async function reapplyRule(ruleId: string, transactionIds: string[], ruleLabel: string): Promise<Result> {
  try {
    const result = await executeAsOwner({
      operation: "rules.reapply",
      input: { ruleId, transactionIds },
      reason: `Re-applied rule ${ruleLabel} to past transactions`,
    });
    const applied = result.status === "applied" ? (result.output as { applied: number }).applied : 0;
    for (const path of ["/categories", "/categories/reapply", "/transactions", "/spending", "/budgets", "/cash-flow"]) revalidatePath(path);
    return { ok: true, message: `Changed ${applied} transaction${applied === 1 ? "" : "s"}. Undo it in Activity if it's not what you wanted.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}
