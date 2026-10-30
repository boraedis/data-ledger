"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Each budget edit is one operation as the owner: validated, logged in
// Activity, undoable there.

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
  revalidatePath("/budgets");
}

export type TargetInput = {
  categoryId: string | null;
  amountCents: number;
  periodMonths: number;
  anchorMonth?: string;
  rollover: boolean;
  sinkingFund: boolean;
};

export async function setTarget(input: TargetInput, name: string) {
  return run("budgets.setTarget", { ...input }, `Set the ${name} target to $${(input.amountCents / 100).toFixed(2)}`);
}

export type BackdateMonth = { month: string; before: { targetCents: number; periodMonths: number } | null; after: { targetCents: number; periodMonths: number } | null };

// What a backdate would change, month by month (#137), shown before it's
// saved. A read: nothing is written.
export async function previewBackdate(input: TargetInput & { fromMonth: string }): Promise<{ error: string } | { months: BackdateMonth[]; until: string | null }> {
  try {
    const result = await executeAsOwner({ operation: "budgets.backdatePreview", input: { ...input }, reason: "Preview" });
    if (result.status !== "read") return { error: "Something went wrong" };
    return result.output as { months: BackdateMonth[]; until: string | null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

// An earlier start for a target (#130): fills months that had none.
export async function backdateTarget(input: TargetInput & { fromMonth: string }, name: string) {
  return run(
    "budgets.backdateTarget",
    { ...input },
    `Backdated the ${name} target to ${input.fromMonth}: $${(input.amountCents / 100).toFixed(2)} until its next version`,
  );
}

export async function removeTarget(categoryId: string | null, name: string) {
  return run("budgets.removeTarget", { categoryId }, `Removed the ${name} target`);
}

export async function rebalance(fromCategoryId: string | null, toCategoryId: string | null, amountCents: number, fromName: string, toName: string) {
  return run(
    "budgets.rebalance",
    { fromCategoryId, toCategoryId, amountCents },
    `Moved $${(amountCents / 100).toFixed(2)} from ${fromName} to ${toName} for this period`,
  );
}
