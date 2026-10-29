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
 * The owner categorizes one transaction (or confirms its suggestion), then
 * the pipeline runs again so any rule picks up the rest. Merchant memory
 * only suggests (#86): the next one from this merchant arrives with this
 * category pre-selected.
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
      return result.byRules;
    });
    revalidatePath("/inbox");
    return { ok: true, autoCategorized };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Confirms a set of inbox suggestions at once (#86), as the owner: one
 * command, so Activity shows one entry and one undo puts them all back.
 */
export async function confirmSuggestions(assignments: { transactionId: string; categoryId: string }[]): Promise<Result> {
  try {
    const autoCategorized = await asOwner(async (db) => {
      await execute(db, {
        operation: "transactions.setCategories",
        input: { assignments },
        actor: "user",
        reason: `Confirmed ${assignments.length} suggested categor${assignments.length === 1 ? "y" : "ies"} in the inbox`,
      });
      return (await runCategorization(db)).byRules;
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
      return result.byRules;
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
 * Its answers come back as suggestions to confirm (#86).
 */
export async function askModel(): Promise<{ error: string } | { ok: true; message: string }> {
  try {
    const result = await asOwner((db) =>
      runCategorization(db, { model: { mode: "interactive", deadline: Date.now() + 270_000, limit: 120 } }),
    );
    revalidatePath("/inbox");
    if (result.modelError && result.modelSeen === 0) {
      // The boot carries on after this request gives up, so a second try in
      // a minute or two usually finds the model awake.
      return { error: `${result.modelError}. It keeps waking up in the background — try again in a minute or two.` };
    }
    const parts = [`The model looked at ${result.modelSeen} and left its suggestions to confirm`];
    if (result.modelError) parts.push(`stopped early: ${result.modelError}`);
    return { ok: true, message: parts.join(", ") + "." };
  } catch (error) {
    return failure(error);
  }
}

type Done = { error: string } | { ok: true };

async function provisionalAction(operation: string, input: Record<string, unknown>, reason: string): Promise<Done> {
  try {
    await asOwner((db) => execute(db, { operation, input, actor: "user", reason }));
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/inbox");
  revalidatePath("/transactions");
  revalidatePath("/");
  return { ok: true };
}

/** A purchase alert the bank reported differently (a tip): the owner says which it was (#30). */
export async function matchAlert(provisionalId: string, transactionId: string) {
  return provisionalAction("transactions.matchProvisional", { pairs: [{ provisionalId, transactionId }] }, "Matched a purchase alert by hand");
}

/** A purchase alert the bank never reported: declined, reversed, or read wrong. */
export async function discardAlert(transactionId: string) {
  return provisionalAction("transactions.discardProvisional", { transactionId }, "Discarded a purchase alert the bank never reported");
}
