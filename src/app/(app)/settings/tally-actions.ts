"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Promoting a Tally action to auto-apply, or making it ask first again (#59):
// each an operation as the owner, logged and undoable in Activity.
export async function setPromotion(operation: string, label: string, promoted: boolean): Promise<{ error: string } | undefined> {
  try {
    await executeAsOwner({
      operation: promoted ? "tally.promote" : "tally.demote",
      input: { operation },
      reason: promoted ? `Let Tally ${label.charAt(0).toLowerCase()}${label.slice(1)} without asking` : `Made Tally ask first to ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't change that" };
  }
  revalidatePath("/settings");
}
