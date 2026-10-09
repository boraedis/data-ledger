"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

type Patch = { kind?: string; displayName?: string | null; countsTowardBudgets?: boolean };

// Validation happens in the operation's own schema; this only forwards the
// edit as the owner, with a reason that reads well in the activity log.
export async function updateAccount(accountId: string, patch: Patch, reason: string): Promise<{ error: string } | undefined> {
  try {
    await executeAsOwner({ operation: "accounts.update", input: { accountId, ...patch }, reason });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't update the account" };
  }
  revalidatePath("/accounts");
}
