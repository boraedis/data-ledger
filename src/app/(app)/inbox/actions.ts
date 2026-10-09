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
