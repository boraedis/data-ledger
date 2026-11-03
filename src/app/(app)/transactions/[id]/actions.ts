"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { matchTransfersAround } from "@/lib/categorize/pipeline";
import { asOwner, executeAsOwner } from "@/operations/server";

export type ActionResult = { error: string } | { ok: true };

// Every edit on the detail page is one operation as the owner, so it's
// validated, logged in Activity and undoable there. Validation errors
// (a split that doesn't add up) come back as messages, not crashes.
async function run(transactionId: string, operation: string, input: Record<string, unknown>, reason: string): Promise<ActionResult> {
  try {
    await executeAsOwner({ operation, input: { transactionId, ...input }, reason });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: { message: string }[] }).issues;
      return { error: issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  return { ok: true };
}

export async function setCategory(transactionId: string, categoryId: string | null) {
  const result = await run(transactionId, "transactions.setCategory", { categoryId }, categoryId ? "Set category" : "Cleared category");
  if ("ok" in result) await pairFiledTransfer(transactionId);
  return result;
}

// Filing a transfer is the moment its other half can be found, so pair just
// this transaction. Nothing else is scanned. A failure here doesn't undo the
// save: the transaction just stays unpaired until the owner files it again.
async function pairFiledTransfer(transactionId: string) {
  try {
    const paired = await asOwner((db) => matchTransfersAround(db, transactionId));
    if (paired) {
      revalidatePath(`/transactions/${transactionId}`);
      revalidatePath("/transactions");
    }
  } catch (error) {
    console.error("Couldn't pair the transfer", error);
  }
}

export async function split(transactionId: string, parts: { amountCents: number; categoryId: string; note: string | null }[]) {
  return run(transactionId, "transactions.split", { parts }, `Split into ${parts.length} parts`);
}

export async function setTags(transactionId: string, tags: string[]) {
  return run(transactionId, "transactions.setTags", { tags }, tags.length ? `Tagged ${tags.map((t) => `#${t}`).join(" ")}` : "Removed tags");
}

export async function setExperienceDate(transactionId: string, experiencedOn: string | null) {
  return run(
    transactionId,
    "transactions.setExperienceDate",
    { experiencedOn },
    experiencedOn ? `Experience date set to ${experiencedOn}` : "Cleared experience date",
  );
}

export async function notATransfer(transactionId: string) {
  return run(transactionId, "transactions.unmatchTransfer", {}, "Marked as not a transfer");
}

// Pairing with a row that already exists (#252): the way back from "Not a
// transfer", which rejects both sides. The operation checks the amounts, the
// accounts and that neither is paired; the page just names the two rows.
export async function pairWithExisting(transactionId: string, otherId: string, amountCents: number): Promise<ActionResult> {
  const [outId, inId] = amountCents < 0 ? [transactionId, otherId] : [otherId, transactionId];
  try {
    await executeAsOwner({ operation: "transactions.pairAsTransfer", input: { outId, inId }, reason: "Paired with an existing transaction by hand" });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  for (const id of [transactionId, otherId]) revalidatePath(`/transactions/${id}`);
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  return { ok: true };
}

// Adding the other half of an unpaired transfer creates a row, so it can't
// go through run(): on success the page moves to the new row, which is where
// the owner can see both sides paired.
export async function addOtherHalf(transactionId: string, accountId: string, description: string): Promise<ActionResult> {
  let addedId: string;
  try {
    const result = await executeAsOwner({
      operation: "transactions.addOtherHalf",
      input: { transactionId, accountId, description },
      reason: "Added the other half of a transfer",
    });
    // The owner's own writes apply at once; only Tally's come back as proposals.
    if (!("output" in result)) throw new Error("The other half wasn't added");
    addedId = (result.output as { transactionId: string }).transactionId;
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: { message: string }[] }).issues;
      return { error: issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  redirect(`/transactions/${addedId}`);
}

export async function discardProvisional(transactionId: string) {
  return run(transactionId, "transactions.discardProvisional", {}, "Discarded a purchase alert the bank never reported");
}

// Transactions added by hand (#64).
export async function updateManual(transactionId: string, change: { postedOn: string; amountCents: number; description: string }) {
  return run(transactionId, "transactions.updateManual", change, "Changed a transaction added by hand");
}

export async function deleteManual(transactionId: string) {
  return run(transactionId, "transactions.deleteManual", {}, "Deleted a transaction added by hand");
}

export async function mergeManual(manualId: string, transactionId: string) {
  const result = await run(manualId, "transactions.mergeManual", { manualId, transactionId }, "Merged a transaction added by hand into the bank's");
  revalidatePath(`/transactions/${transactionId}`);
  return result;
}

export async function keepManual(transactionId: string) {
  return run(transactionId, "transactions.keepManual", {}, "Kept a transaction added by hand alongside the bank's");
}
