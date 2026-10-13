"use server";

import { revalidatePath } from "next/cache";
import { approveAsOwner, rejectAsOwner } from "@/operations/server";

// Approving or rejecting one of Tally's proposals, from the chat. The same
// path as Activity's buttons: applied as the owner's decision, and the
// command stays logged with actor "tally".

export async function decide(commandId: string, approve: boolean): Promise<{ error: string } | { status: "applied" | "rejected" }> {
  try {
    if (approve) await approveAsOwner(commandId);
    else await rejectAsOwner(commandId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath("/tally");
  revalidatePath("/activity");
  return { status: approve ? "applied" : "rejected" };
}
