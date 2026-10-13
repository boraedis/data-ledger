"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Recurring charges and alerts (#9), as the owner: logged and undoable.

type Result = { error: string } | undefined;

async function run(operation: string, input: Record<string, unknown>, reason: string): Promise<Result> {
  try {
    await executeAsOwner({ operation, input, reason });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath("/subscriptions");
  revalidatePath("/");
}

export async function setStatus(merchant: string, accountId: string, status: "confirmed" | "dismissed" | null) {
  const verb = status === "confirmed" ? "Tracking" : status === "dismissed" ? "Dismissed" : "Stopped tracking";
  return run("recurring.setStatus", { merchant, accountId, status }, `${verb} ${merchant} as recurring`);
}

export async function dismissAlert(alertId: string, title: string) {
  return run("alerts.dismiss", { alertId }, `Dismissed alert: ${title}`);
}

export async function checkNow() {
  return run("alerts.refresh", {}, "Checked for subscription alerts");
}
