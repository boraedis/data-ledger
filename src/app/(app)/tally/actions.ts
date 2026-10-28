"use server";

import { revalidatePath } from "next/cache";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listConversations } from "@/lib/tally/agent";
import { conversationItems, type Item } from "@/lib/tally/history";
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

// What the panel (#72) shows when it opens: the most recently active
// conversation, re-read each time, so whichever thread was last talked in,
// here or on the full page, is the one it picks up.
export async function panelConversation(): Promise<{ conversationId: string | null; items: Item[] }> {
  if (!(await hasValidSession())) throw new Error("Not signed in");
  const db = getDb();
  const id = (await listConversations(db, 1))[0]?.id ?? null;
  return { conversationId: id, items: id ? await conversationItems(db, id) : [] };
}
