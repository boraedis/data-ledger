"use server";

import { revalidatePath } from "next/cache";
import { formatCents } from "@/lib/money";
import { executeAsOwner } from "@/operations/server";

// Shared expenses and reimbursements (#8), as the owner. Every action is one
// logged, undoable operation. Used by the Owed page and the transaction page.
//
// A reason with an amount in it is written here, from the figure, not by
// the page (#364): a page in privacy mode shows `$•••`, and that mustn't
// be what Activity keeps. Here, outside a render, amounts are always exact.

type Result = { error: string } | { ok: true; output?: unknown };

async function run(operation: string, input: Record<string, unknown>, reason: string, paths: string[] = []): Promise<Result> {
  let output: unknown;
  try {
    const result = await executeAsOwner({ operation, input, reason });
    // The owner's writes always apply; "proposed" is only ever Tally's.
    output = "output" in result ? result.output : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      return { error: (error as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ") };
    }
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  for (const path of ["/owed", "/inbox", "/transactions", "/budgets/month", ...paths]) revalidatePath(path);
  return { ok: true, output };
}

export async function addPerson(name: string, aliases: string[]) {
  return run("people.create", { name, aliases }, `Added ${name}`);
}

export async function updatePerson(personId: string, name: string, aliases: string[]) {
  return run("people.update", { personId, name, aliases }, `Updated ${name}`);
}

export async function setShares(transactionId: string, shares: { personId: string; amountCents: number }[], summary: string) {
  return run("reimbursements.setShares", { transactionId, shares }, summary, [`/transactions/${transactionId}`]);
}

export async function confirmMatch(transactionId: string, allocations: { reimbursementId: string; amountCents: number }[], personName: string) {
  const total = allocations.reduce((s, a) => s + a.amountCents, 0);
  return run("reimbursements.match", { transactionId, allocations }, `Matched ${formatCents(total)} from ${personName}`, [`/transactions/${transactionId}`]);
}

export async function unmatchPayment(transactionId: string) {
  return run("reimbursements.unmatch", { transactionId }, "Unmatched a reimbursement payment", [`/transactions/${transactionId}`]);
}

export async function dismissPayment(transactionId: string) {
  return run("reimbursements.dismiss", { transactionId }, "Not a reimbursement");
}

export async function forgive(reimbursementId: string, about: { personName: string; remainingCents: number; merchant?: string | null }) {
  const reason = `Forgave ${about.personName}'s remaining ${formatCents(about.remainingCents)}${about.merchant ? ` for ${about.merchant}` : ""}`;
  return run("reimbursements.forgive", { reimbursementId }, reason);
}
