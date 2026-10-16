"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { hasValidSession } from "@/lib/auth/session";
import { openDeposits } from "@/operations/pay";
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
  // Undefined: link automatically if exactly one deposit fits.
  depositTransactionId?: string | null;
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

export async function linkDeposit(payStubId: string, depositTransactionId: string | null) {
  return run("payStubs.linkDeposit", { payStubId, depositTransactionId }, depositTransactionId ? "Linked a pay stub to its deposit" : "Unlinked a pay stub's deposit");
}

/** Deposits the form can offer for a pay date and net: dates and amounts only. */
export async function findDeposits(payDate: string, netCents: number, payStubId?: string) {
  if (!(await hasValidSession())) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate) || !Number.isSafeInteger(netCents) || netCents <= 0) return [];
  return openDeposits(getDb(), { payDate, netCents }, payStubId);
}
