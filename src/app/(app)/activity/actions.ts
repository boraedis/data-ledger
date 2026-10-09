"use server";

import { revalidatePath } from "next/cache";
import { approveAsOwner, rejectAsOwner, undoAsOwner } from "@/operations/server";

// Errors are returned rather than thrown so the page can show "this changed
// since — undo the newer change first" instead of Next's generic error page.
type Result = { error: string } | undefined;

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath("/activity");
}

export async function approve(commandId: string) {
  return run(() => approveAsOwner(commandId));
}

export async function reject(commandId: string) {
  return run(() => rejectAsOwner(commandId));
}

export async function undo(commandId: string) {
  return run(() => undoAsOwner(commandId));
}
