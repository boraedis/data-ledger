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
  revalidatePath("/net-worth");
}

type Result = Promise<{ error: string } | undefined>;

async function run(operation: string, input: Record<string, unknown>, reason: string, fallback: string): Result {
  try {
    await executeAsOwner({ operation, input, reason });
  } catch (error) {
    return { error: error instanceof Error ? error.message : fallback };
  }
  revalidatePath("/accounts");
  revalidatePath("/net-worth");
}

export async function createManualAccount(input: { name: string; kind: string; valueCents: number; on: string }): Result {
  return run("accounts.createManual", input, `Added manual account "${input.name}"`, "Couldn't add the account");
}

export async function setManualValue(accountId: string, name: string, valueCents: number, on: string): Result {
  return run("accounts.setManualValue", { accountId, valueCents, on }, `Updated the value of "${name}" as of ${on}`, "Couldn't update the value");
}

export async function deleteManualAccount(accountId: string, name: string): Result {
  return run("accounts.deleteManual", { accountId }, `Removed manual account "${name}"`, "Couldn't remove the account");
}
