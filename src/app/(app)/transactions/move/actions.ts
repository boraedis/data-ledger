"use server";

import { revalidatePath } from "next/cache";
import { executeAsOwner } from "@/operations/server";

type Result = { error: string } | { ok: true; message?: string; unusedCategoryIds?: string[] };

const refresh = () => {
  for (const path of ["/transactions", "/transactions/move", "/categories", "/spending", "/budgets", "/cash-flow", "/inbox"]) revalidatePath(path);
};

// Moving the rows the owner left ticked in the preview (#116): one command
// as the owner, undone together in Activity.
export async function moveTransactions(categoryId: string, categoryName: string, transactionIds: string[]): Promise<Result> {
  try {
    const result = await executeAsOwner({
      operation: "transactions.moveToCategory",
      input: { categoryId, transactionIds },
      reason: `Moved ${transactionIds.length} transaction${transactionIds.length === 1 ? "" : "s"} to ${categoryName}`,
    });
    const output = result.status === "applied" ? (result.output as { moved: number; unusedCategoryIds: string[] }) : { moved: 0, unusedCategoryIds: [] };
    refresh();
    return {
      ok: true,
      message: `Moved ${output.moved} to ${categoryName}. Undo it in Activity if it's not what you wanted.`,
      unusedCategoryIds: output.unusedCategoryIds,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

// Offered once a move leaves a category with nothing in it.
export async function deleteUnusedCategory(categoryId: string, name: string): Promise<{ error: string } | { ok: true }> {
  try {
    await executeAsOwner({ operation: "categories.delete", input: { categoryId }, reason: `Deleted "${name}", unused after a move` });
    refresh();
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
}
