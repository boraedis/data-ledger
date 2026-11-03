import { eq } from "drizzle-orm";
import { z } from "zod";
import { tallyPromotions } from "@/db/schema";
import type { Db } from "@/db/types";
import { defineWrite, type WriteOperation } from "@/operations/define";

// Promoting a Tally action to auto-apply (#59). Tally proposes and the owner
// approves, except for an operation the owner has promoted here: then
// Tally's write applies straight away, logged as auto-applied, with its
// reason and undo like any other (src/operations/runtime.ts).
//
// Only the owner promotes or demotes, and only an operation marked
// promotable in its own definition: routine, low-risk and undoable. Every
// promotion is off until the owner turns it on in Settings.

// The registry imports this module, so it's loaded when needed rather than
// at the top, to keep the import graph acyclic.
async function promotableOperation(name: string): Promise<WriteOperation> {
  const { getOperation } = await import("@/operations/registry");
  const op = getOperation(name);
  if (!op || op.kind !== "write" || !op.promotable) throw new Error(`${name} can't be promoted: Tally always asks first`);
  return op;
}

export const promoteForTally = defineWrite({
  name: "tally.promote",
  description: "Let Tally apply one kind of write without asking: only for operations marked promotable.",
  allowedActors: ["user"],
  input: z.object({ operation: z.string().min(1).max(80) }),
  apply: async (ctx, { operation }) => {
    await promotableOperation(operation);
    const [existing] = await ctx.db.select().from(tallyPromotions).where(eq(tallyPromotions.operation, operation));
    if (existing) throw new Error("Tally already applies this without asking");
    const row = await ctx.insert(tallyPromotions, { operation });
    return { id: row.id };
  },
});

export const demoteForTally = defineWrite({
  name: "tally.demote",
  description: "Make Tally ask first again for one kind of write.",
  allowedActors: ["user"],
  input: z.object({ operation: z.string().min(1).max(80) }),
  apply: async (ctx, { operation }) => {
    const [existing] = await ctx.db.select().from(tallyPromotions).where(eq(tallyPromotions.operation, operation));
    if (!existing) throw new Error("Tally already asks first for this");
    await ctx.remove(tallyPromotions, existing.id);
    return { id: existing.id };
  },
});

/** Whether Tally may apply this operation without asking, read fresh each time. */
export async function isPromoted(db: Db, operation: string): Promise<boolean> {
  const [row] = await db.select({ id: tallyPromotions.id }).from(tallyPromotions).where(eq(tallyPromotions.operation, operation));
  return Boolean(row);
}

/** Every promotable operation and whether it's promoted, for Settings. Not an operation: Tally has no use for it. */
export async function listPromotions(db: Db): Promise<{ operation: string; label: string; promoted: boolean }[]> {
  const { describePromotable } = await import("@/operations/registry");
  const promoted = new Set((await db.select({ operation: tallyPromotions.operation }).from(tallyPromotions)).map((r) => r.operation));
  return describePromotable().map((op) => ({ ...op, promoted: promoted.has(op.operation) }));
}
