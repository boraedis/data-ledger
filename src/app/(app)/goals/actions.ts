"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Savings goals (#10), as the owner: logged and undoable.

export type GoalFields = { name: string; targetCents: number; targetDate: string | null; accountIds: string[]; tagName: string | null };
type Result = { error: string } | undefined;

async function run(operation: string, input: Record<string, unknown>, reason: string): Promise<Result> {
  try {
    await executeAsOwner({ operation, input, reason });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      return { error: (error as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath("/goals");
}

export async function createGoal(fields: GoalFields) {
  return run("goals.create", { ...fields }, `Created the goal "${fields.name}"`);
}

export async function updateGoal(goalId: string, fields: GoalFields) {
  return run("goals.update", { goalId, ...fields }, `Updated the goal "${fields.name}"`);
}

export async function archiveGoal(goalId: string, name: string, archived: boolean) {
  return run("goals.archive", { goalId, archived }, archived ? `Archived the goal "${name}"` : `Restored the goal "${name}"`);
}
