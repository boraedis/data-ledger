"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

export type ActionResult = { error: string } | { ok: true };

// Every edit on the detail page is one operation as the owner, so it's
// validated, logged in Activity and undoable there. Validation errors
// (a split that doesn't add up) come back as messages, not crashes.
async function run(transactionId: string, operation: string, input: Record<string, unknown>, reason: string): Promise<ActionResult> {
  try {
    await executeAsOwner({ operation, input: { transactionId, ...input }, reason });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: { message: string }[] }).issues;
      return { error: issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  return { ok: true };
}

export async function setCategory(transactionId: string, categoryId: string | null) {
  return run(transactionId, "transactions.setCategory", { categoryId }, categoryId ? "Set category" : "Cleared category");
}

export async function split(transactionId: string, parts: { amountCents: number; categoryId: string; note: string | null }[]) {
  return run(transactionId, "transactions.split", { parts }, `Split into ${parts.length} parts`);
}

export async function setTags(transactionId: string, tags: string[]) {
  return run(transactionId, "transactions.setTags", { tags }, tags.length ? `Tagged ${tags.map((t) => `#${t}`).join(" ")}` : "Removed tags");
}

export async function setExperienceDate(transactionId: string, experiencedOn: string | null) {
  return run(
    transactionId,
    "transactions.setExperienceDate",
    { experiencedOn },
    experiencedOn ? `Experience date set to ${experiencedOn}` : "Cleared experience date",
  );
}
