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

// Positions kept by hand (#231). Reasons name the symbol, never a quantity or price.
export async function addPosition(
  input: { accountId: string; symbol: string; quantity: string; unitPrice: string; priceOn: string; costBasisCents: number | null; assetClass: "crypto" | "equity"; heldSince?: string },
  accountName: string,
): Result {
  return run("holdings.addManual", input, `Added ${input.symbol.toUpperCase()} to "${accountName}"`, "Couldn't add the position");
}

export async function setPositionPrice(positionId: string, symbol: string, unitPrice: string, priceOn: string): Result {
  return run("holdings.setPrice", { positionId, unitPrice, priceOn }, `Updated the price of ${symbol} as of ${priceOn}`, "Couldn't update the price");
}

export async function setPositionAssetClass(positionId: string, symbol: string, assetClass: "crypto" | "equity"): Result {
  return run("holdings.setAssetClass", { positionId, assetClass }, `Marked ${symbol} as ${assetClass === "equity" ? "a stock, ETF or fund" : "a coin"}`, "Couldn't change the kind of asset");
}

export async function removePosition(positionId: string, symbol: string): Result {
  return run("holdings.remove", { positionId }, `Removed ${symbol}`, "Couldn't remove the position");
}

// The past of a hand-entered position (#340).
export async function setHeldSince(positionId: string, symbol: string, heldSince: string): Result {
  return run("holdings.setHeldSince", { positionId, heldSince }, `Said ${symbol} has been held since ${heldSince}`, "Couldn't change when it's held since");
}

export async function setPastPrice(positionId: string, symbol: string, on: string, price: string): Result {
  return run("holdings.setPastPrice", { positionId, on, price }, `Gave ${symbol} a price on ${on}`, "Couldn't record the price");
}

export async function removePastPrice(positionId: string, symbol: string, on: string): Result {
  return run("holdings.removePastPrice", { positionId, on }, `Removed ${symbol}'s price on ${on}`, "Couldn't remove the price");
}
