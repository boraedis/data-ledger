"use server";

import { revalidatePath } from "next/cache";
import { runCategorization } from "@/lib/categorize/pipeline";
import { execute } from "@/operations/runtime";
import { asOwner } from "@/operations/server";

// Adding a transaction by hand (#64), as the owner. With no category given,
// the owner's rules run, as they would on the bank's own transactions;
// anything left waits in the inbox.
export async function addTransaction(input: {
  accountId: string;
  postedOn: string;
  amountCents: number;
  description: string;
  categoryId: string | null;
}): Promise<{ error: string } | { transactionId: string }> {
  try {
    const transactionId = await asOwner(async (db) => {
      const result = await execute(db, {
        operation: "transactions.createManual",
        input: { ...input, categoryId: input.categoryId ?? undefined },
        actor: "user",
        reason: `Added by hand: ${input.description}`,
      });
      if (result.status !== "applied") throw new Error("It wasn't added");
      if (!input.categoryId) await runCategorization(db);
      return (result.output as { transactionId: string }).transactionId;
    });
    for (const path of ["/transactions", "/inbox", "/spending", "/budgets/month", "/cash-flow"]) revalidatePath(path);
    return { transactionId };
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      return { error: (error as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Couldn't add it" };
  }
}
