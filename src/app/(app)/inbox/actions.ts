"use server";

import { revalidatePath } from "next/cache";
import { runCategorization } from "@/lib/categorize/pipeline";
import { execute } from "@/operations/runtime";
import { asOwner } from "@/operations/server";

type Result = { error: string } | { ok: true; autoCategorized: number };

function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : "Something went wrong" };
}

/**
 * The owner categorizes one transaction, then the pipeline runs again so
 * merchant memory immediately picks up anything else from the same
 * merchant — the inbox shrinks as you go instead of asking twice.
 */
export async function categorize(transactionId: string, categoryId: string): Promise<Result> {
  try {
    const autoCategorized = await asOwner(async (db) => {
      await execute(db, {
        operation: "transactions.setCategory",
        input: { transactionId, categoryId },
        actor: "user",
        reason: "Categorized in the inbox",
      });
      const result = await runCategorization(db);
      return result.byRules + result.byMemory;
    });
    revalidatePath("/inbox");
    return { ok: true, autoCategorized };
  } catch (error) {
    return failure(error);
  }
}

/** "Always categorize this merchant as that": a merchant-equals rule, applied right away. */
export async function createMerchantRule(merchant: string, categoryId: string): Promise<Result> {
  try {
    const autoCategorized = await asOwner(async (db) => {
      await execute(db, {
        operation: "rules.create",
        input: { matchField: "merchant", matchType: "equals", pattern: merchant, categoryId },
        actor: "user",
        reason: `Rule created from the inbox for ${merchant}`,
      });
      const result = await runCategorization(db);
      return result.byRules + result.byMemory;
    });
    revalidatePath("/inbox");
    revalidatePath("/categories");
    return { ok: true, autoCategorized };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Sends what rules and memory couldn't handle to the model, as many
 * batches as fit in this request's time (a cold start alone is ~3.5 min).
 * Confident answers are applied; the rest come back as suggestions.
 */
export async function askModel(): Promise<{ error: string } | { ok: true; message: string }> {
  try {
    const result = await asOwner((db) =>
      runCategorization(db, { model: { mode: "interactive", deadline: Date.now() + 270_000, limit: 120 } }),
    );
    revalidatePath("/inbox");
    if (result.modelError && result.modelSeen === 0) return { error: result.modelError };
    const parts = [`The model looked at ${result.modelSeen}`, `categorized ${result.byModel} confidently`];
    if (result.modelSeen > result.byModel) parts.push(`left ${result.modelSeen - result.byModel} as suggestions`);
    if (result.modelError) parts.push(`stopped early: ${result.modelError}`);
    return { ok: true, message: parts.join(", ") + "." };
  } catch (error) {
    return failure(error);
  }
}
