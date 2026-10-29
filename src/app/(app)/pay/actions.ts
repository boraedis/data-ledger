"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { hasValidSession } from "@/lib/auth/session";
import { listAccounts } from "@/operations/accounts";
import { openDeposits } from "@/operations/pay";
import { read } from "@/operations/runtime";
import { executeAsOwner } from "@/operations/server";

// Pay stubs (#60), as the owner: logged and undoable.

export type StubLine = { kind: string; label: string; amountCents: number; categoryId: string | null };
export type StubFields = {
  employer: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  grossCents: number;
  netCents: number;
  lines: StubLine[];
  // Undefined: link automatically if exactly one way fits (one deposit, or
  // pay split across accounts).
  depositTransactionIds?: string[] | null;
};
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
  revalidatePath("/pay");
  revalidatePath("/budgets");
}

export async function createStub(fields: StubFields) {
  return run("payStubs.create", fields, `Pay stub for ${fields.payDate}`);
}

export async function updateStub(payStubId: string, fields: StubFields) {
  return run("payStubs.update", { payStubId, ...fields }, `Edited the ${fields.payDate} pay stub`);
}

export async function deleteStub(payStubId: string, payDate: string) {
  return run("payStubs.delete", { payStubId }, `Deleted the ${payDate} pay stub`);
}

export async function linkDeposits(payStubId: string, depositTransactionIds: string[] | null) {
  return run(
    "payStubs.linkDeposit",
    { payStubId, depositTransactionIds },
    depositTransactionIds ? "Linked a pay stub to its deposits" : "Unlinked a pay stub's deposits",
  );
}

export type DepositMatch = { ids: string[]; parts: { postedOn: string; amountCents: number; accountName: string }[] };

/**
 * The ways deposits could make up a pay date's net, for the form to offer:
 * one deposit, or pay split across accounts, including splits whose
 * deposits the bank names differently. `automatic` is the one saving
 * would link on its own (only a same-payer match, and only if it's the
 * only one), or null. Dates, amounts and account names only.
 */
export async function findDeposits(payDate: string, netCents: number, payStubId?: string): Promise<{ matches: DepositMatch[]; automatic: string[] | null }> {
  const none = { matches: [], automatic: null };
  if (!(await hasValidSession())) return none;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate) || !Number.isSafeInteger(netCents) || netCents <= 0) return none;
  const db = getDb();
  const stub = { payDate, netCents };
  const [strict, any, accts] = await Promise.all([
    openDeposits(db, stub, payStubId),
    openDeposits(db, stub, payStubId, { anyPayer: true }),
    read(db, listAccounts, {}),
  ]);
  const names = new Map(accts.map((a) => [a.id, a.name]));
  return {
    matches: any.map((m) => ({
      ids: m.map((d) => d.id),
      parts: m.map((d) => ({ postedOn: d.postedOn, amountCents: d.amountCents, accountName: names.get(d.accountId) ?? "" })),
    })),
    automatic: strict.length === 1 ? strict[0].map((d) => d.id) : null,
  };
}
