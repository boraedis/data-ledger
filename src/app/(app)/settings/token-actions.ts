"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createApiToken, revokeApiToken } from "@/lib/auth/api-tokens";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

// Server actions are reachable POST endpoints in their own right, so each
// re-checks the session rather than trusting that the page was gated.
async function assertOwner() {
  if (!(await hasValidSession())) throw new Error("Not signed in");
}

export async function createToken(label: string): Promise<{ token: string } | { error: string }> {
  await assertOwner();
  const parsed = z.string().trim().min(1).max(60).safeParse(label);
  if (!parsed.success) return { error: "Give the token a name (up to 60 characters)." };
  const { token } = await createApiToken(getDb(), parsed.data);
  revalidatePath("/settings");
  // Returned once, to this response only. It isn't stored anywhere in a
  // form that can be shown again.
  return { token };
}

export async function revokeToken(id: string): Promise<void> {
  await assertOwner();
  await revokeApiToken(getDb(), z.uuid().parse(id));
  revalidatePath("/settings");
}
