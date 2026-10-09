"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasValidSession } from "@/lib/auth/session";
import { addSimpleFinConnection } from "@/lib/connectors";
import { SetupTokenError } from "@/lib/connectors/simplefin";
import { withTransactionalDb } from "@/lib/db";
import { syncConnection } from "@/lib/sync/run";

// Server actions are POST endpoints in their own right; each re-checks the
// session instead of trusting that the page was gated.
async function assertOwner() {
  if (!(await hasValidSession())) throw new Error("Not signed in");
}

type Result = { error: string } | { ok: true; message?: string };

const AddInput = z.object({
  label: z.string().trim().min(1).max(60),
  setupToken: z.string().trim().min(20),
});

export async function addConnection(label: string, setupToken: string): Promise<Result> {
  await assertOwner();
  const parsed = AddInput.safeParse({ label, setupToken });
  if (!parsed.success) return { error: "Give the connection a name and paste the whole setup token." };

  try {
    return await withTransactionalDb(async (db) => {
      const id = await addSimpleFinConnection(db, parsed.data);
      // Pull the first 90 days right away rather than waiting for tonight.
      const result = await syncConnection(db, id, { trigger: "setup" });
      revalidatePath("/settings");
      return "error" in result
        ? { ok: true as const, message: `Connected, but the first sync didn't complete: ${result.error}` }
        : { ok: true as const, message: `Connected. Imported ${result.inserted} transactions.` };
    });
  } catch (error) {
    // Setup-token problems are the owner's to fix and safe to show; anything
    // else might carry details we don't want echoed, so keep it generic.
    if (error instanceof SetupTokenError) return { error: error.message };
    console.error(error);
    return { error: "Couldn't connect. Check the token and try again." };
  }
}

export async function syncNow(connectionId: string): Promise<Result> {
  await assertOwner();
  const id = z.uuid().parse(connectionId);
  const result = await withTransactionalDb((db) => syncConnection(db, id, { trigger: "manual" }));
  revalidatePath("/settings");
  revalidatePath("/");
  if ("error" in result) return { error: result.error };
  return { ok: true, message: `Synced: ${result.inserted} new, ${result.updated} updated, ${result.removed} removed.` };
}
