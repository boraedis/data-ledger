"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

// Every change to a trade (#319), as the owner: validated by the operation,
// logged in Activity and undoable there. Reasons name the symbol, never a
// quantity or price.

type Result = Promise<{ error: string } | undefined>;

async function run(operation: string, input: Record<string, unknown>, reason: string, fallback: string): Result {
  try {
    await executeAsOwner({ operation, input, reason });
  } catch (error) {
    return { error: error instanceof Error ? error.message : fallback };
  }
  // Trades move manual positions, account values and the rebuilt history.
  for (const path of ["/trades", "/accounts", "/investments", "/net-worth"]) revalidatePath(path);
}

const named = (symbol: string | null) => (symbol ? symbol.toUpperCase() : "a position");

export async function addTrade(
  input: { accountId: string; on: string; side: string; symbol: string; quantity: string; price: string | null; assetClass?: "crypto" | "equity" },
  accountName: string,
): Result {
  return run("trades.add", input, `Recorded a trade of ${named(input.symbol)} in "${accountName}"`, "Couldn't record the trade");
}

export async function updateTrade(
  tradeId: string,
  symbol: string | null,
  changes: { on?: string; onFrom?: string | null; symbol?: string; side?: string; quantity?: string; price?: string | null },
): Result {
  return run("trades.update", { tradeId, ...changes }, `Corrected a trade of ${named(changes.symbol ?? symbol)}`, "Couldn't change the trade");
}

/** A draft's fields and its confirmation, as two commands: each is in Activity on its own. */
export async function finishAndConfirm(
  tradeId: string,
  symbol: string | null,
  changes: { on?: string; onFrom?: string | null; symbol?: string; side?: string; quantity?: string; price?: string | null },
  assetClass?: "crypto" | "equity",
): Result {
  if (Object.keys(changes).length) {
    const failed = await updateTrade(tradeId, symbol, changes);
    if (failed) return failed;
  }
  return run("trades.confirm", { tradeId, ...(assetClass ? { assetClass } : {}) }, `Confirmed a trade of ${named(changes.symbol ?? symbol)}`, "Couldn't confirm the trade");
}

export async function dismissTrade(tradeId: string, symbol: string | null): Result {
  return run("trades.dismiss", { tradeId }, `Dismissed a draft trade of ${named(symbol)}`, "Couldn't dismiss the trade");
}

export async function restoreTrade(tradeId: string, symbol: string | null): Result {
  return run("trades.restore", { tradeId }, `Restored a draft trade of ${named(symbol)}`, "Couldn't restore the trade");
}

export async function removeTrade(tradeId: string, symbol: string | null): Result {
  return run("trades.remove", { tradeId }, `Removed a trade of ${named(symbol)}`, "Couldn't remove the trade");
}
