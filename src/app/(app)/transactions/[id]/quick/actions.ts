"use server";

import { revalidatePath } from "next/cache";
import type { ExecuteResult } from "@/operations/runtime";
import { executeAsOwner, undoAsOwner } from "@/operations/server";

// The quick-file screen's writes (#34): the same operations as the full
// transaction page, as the owner, returning the command so the screen can
// offer Undo right there.

export type QuickResult = { error: string } | { ok: true; commandId: string };

async function run(fn: () => Promise<ExecuteResult>): Promise<QuickResult> {
  try {
    const result = await fn();
    if (!("commandId" in result)) throw new Error("Nothing was changed");
    const { commandId } = result;
    revalidatePath("/inbox");
    revalidatePath("/transactions");
    return { ok: true, commandId };
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      return { error: (error as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function fileAs(transactionId: string, categoryId: string) {
  return run(() => executeAsOwner({ operation: "transactions.setCategory", input: { transactionId, categoryId }, reason: "Filed from a notification" }));
}

export async function splitInto(transactionId: string, parts: { amountCents: number; categoryId: string }[]) {
  return run(() => executeAsOwner({ operation: "transactions.split", input: { transactionId, parts }, reason: `Split from a notification into ${parts.length} parts` }));
}

export async function undo(commandId: string): Promise<{ error: string } | { ok: true }> {
  try {
    await undoAsOwner(commandId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't undo" };
  }
  revalidatePath("/inbox");
  revalidatePath("/transactions");
  return { ok: true };
}
