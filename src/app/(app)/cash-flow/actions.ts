"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Settling a pair flagged as a transfer filed as spending or income (#102):
// one operation as the owner, logged in Activity and undoable there.
async function run(operation: string, input: Record<string, unknown>, reason: string): Promise<{ error: string } | { ok: true }> {
  try {
    await executeAsOwner({ operation, input, reason });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  for (const path of ["/cash-flow", "/spending", "/budgets/month", "/transactions", "/inbox", "/categories/reapply"]) revalidatePath(path);
  return { ok: true };
}

export async function pairAsTransfer(outId: string, inId: string) {
  return run("transactions.pairAsTransfer", { outId, inId }, "Paired as a transfer: it was filed as spending or income");
}

export async function dismissTransfer(outId: string, inId: string) {
  return run("transactions.dismissTransfer", { transactionIds: [outId, inId] }, "Not a transfer: kept as filed");
}
