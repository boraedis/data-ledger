"use server";

import { revalidatePath } from "next/cache";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { chat, ModelError, ModelNotConfiguredError, ModelUnavailableError } from "@/lib/model/client";

/**
 * A one-line round trip to the model. No financial data in it. May start
 * the GPU (and its idle window of billing) if the model was asleep.
 */
export async function testModel(): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await hasValidSession())) throw new Error("Not signed in");
  try {
    const result = await chat(
      {
        feature: "test",
        mode: "interactive",
        messages: [
          { role: "system", content: "Reply with exactly: OK" },
          { role: "user", content: "ping" },
        ],
        maxTokens: 5,
      },
      { db: getDb() },
    );
    revalidatePath("/settings");
    const wake = result.coldStartRetries ? ` (woke up from idle: ${result.coldStartRetries} retries)` : "";
    return { ok: true, message: `Answered "${(result.content ?? "").trim()}" in ${(result.latencyMs / 1000).toFixed(1)}s${wake}` };
  } catch (error) {
    revalidatePath("/settings");
    if (error instanceof ModelNotConfiguredError || error instanceof ModelUnavailableError || error instanceof ModelError) {
      return { error: error.message };
    }
    return { error: "Unexpected error talking to the model" };
  }
}
