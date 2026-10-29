"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

export type AssumptionFields = {
  year: number;
  filingStatus: "single" | "married_joint" | "married_separate" | "head_of_household";
  otherIncomeCents: number;
  itemizedDeductionsCents: number | null;
  creditsCents: number;
  otherPaymentsCents: number;
  hsaCoverage: "self" | "family" | null;
  hsaCatchUp: boolean;
};

// The owner's inputs to the tax estimate (#61): logged and undoable.
export async function saveAssumptions(fields: AssumptionFields): Promise<{ error: string } | undefined> {
  try {
    await executeAsOwner({ operation: "taxes.setAssumptions", input: fields, reason: `Tax assumptions for ${fields.year}` });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) return { error: "Amounts must be dollars, zero or more" };
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath("/pay/taxes");
}
