"use server";

import { revalidatePath } from "next/cache";
import { execute } from "@/operations/runtime";
import { suggestMerchantTypes } from "@/lib/merchants/suggest-types";
import { modelIsConfigured } from "@/lib/model/client";
import { approveAsOwner, asOwner, rejectAsOwner } from "@/operations/server";

type Result = { error: string } | { ok: true; id?: string };

// Each edit is one operation as the owner (validated, logged, undoable in
// Activity), as on the Categories page.
async function run(operation: string, input: Record<string, unknown>, reason: string): Promise<Result> {
  try {
    const output = await asOwner(async (db) => {
      const result = await execute(db, { operation, input, actor: "user", reason });
      return result.status === "applied" ? (result.output as Record<string, unknown> | undefined) : undefined;
    });
    revalidatePath("/merchants", "layout");
    const id = typeof output?.merchantId === "string" ? output.merchantId : typeof output?.typeId === "string" ? output.typeId : undefined;
    return { ok: true, id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function renameMerchant(merchantId: string, name: string) {
  return run("merchants.rename", { merchantId, name }, `Renamed a merchant to "${name}"`);
}

export async function setMerchantType(merchantId: string, typeId: string | null) {
  return run("merchants.setType", { merchantId, typeId }, typeId ? "Set a merchant's type" : "Cleared a merchant's type");
}

export async function addMerchantType(name: string) {
  return run("merchants.addType", { name }, `Added the merchant type "${name}"`);
}

export async function mergeMerchants(keepId: string, mergeId: string) {
  return run("merchants.merge", { keepId, mergeId }, "Merged two merchants");
}

export async function splitAlias(aliasId: string) {
  return run("merchants.splitAlias", { aliasId }, "Split a name out into a merchant of its own");
}

export async function dismissMerge(merchantId: string, otherId: string) {
  return run("merchants.dismissMerge", { merchantId, otherId }, "Said two merchants aren't the same");
}

export async function rederiveMerchants() {
  try {
    const changed = await asOwner(async (db) => {
      const result = await execute(db, { operation: "merchants.rederive", input: {}, actor: "user", reason: "Re-ran the merchant name cleanup over history" });
      return result.status === "applied" ? ((result.output as { changed: number }).changed ?? 0) : 0;
    });
    revalidatePath("/", "layout");
    return { ok: true as const, changed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

/** Proposes a type for merchants without one (#293): from their usual category, then the model from names. */
export async function suggestTypes() {
  try {
    const result = await asOwner((db) => suggestMerchantTypes(db, { model: modelIsConfigured() }));
    revalidatePath("/merchants", "layout");
    return { ok: true as const, ...result, modelOff: !modelIsConfigured() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function decideTypeSuggestion(commandId: string, approve: boolean) {
  try {
    await (approve ? approveAsOwner(commandId) : rejectAsOwner(commandId));
    revalidatePath("/merchants", "layout");
    revalidatePath("/activity");
    return { ok: true as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}
