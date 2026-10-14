"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { createToken, forgetUnmappedCard, revokeToken } from "@/lib/shortcuts/tokens";
import { executeAsOwner } from "@/operations/server";

// The Apple Pay Shortcut (#32): device tokens and Wallet card mapping.

type Result = { error: string } | { ok: true };

const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : "Something went wrong" });

/** The token is returned once, here, and never again: only its hash is kept. */
export async function newToken(label: string): Promise<{ error: string } | { ok: true; token: string }> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  const name = z.string().trim().min(1).max(40).safeParse(label);
  if (!name.success) return { error: "Name the device, e.g. iPhone" };
  const { token } = await createToken(getDb(), name.data);
  revalidatePath("/settings");
  return { ok: true, token };
}

export async function revoke(id: string): Promise<Result> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  if (!z.uuid().safeParse(id).success) return { error: "Unknown token" };
  await revokeToken(getDb(), id);
  revalidatePath("/settings");
  return { ok: true };
}

/** Maps a Wallet card name to an account (null unmaps), through accounts.update. */
export async function mapCard(accountId: string, cardName: string | null): Promise<Result> {
  try {
    await executeAsOwner({
      operation: "accounts.update",
      input: { accountId, walletCardName: cardName },
      reason: cardName ? `Apple Pay card "${cardName}"` : "Removed Apple Pay card name",
    });
    if (cardName) await forgetUnmappedCard(getDb(), cardName);
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) return { error: "Give the card's name as it appears in Wallet" };
    return failure(error);
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function dismissCard(name: string): Promise<Result> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  await forgetUnmappedCard(getDb(), name);
  revalidatePath("/settings");
  return { ok: true };
}
