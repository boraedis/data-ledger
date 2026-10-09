import "server-only";
import { hasValidSession } from "@/lib/auth/session";
import { withTransactionalDb } from "@/lib/db";
import {
  approveProposal,
  execute,
  rejectProposal,
  undoCommand,
  type ExecuteRequest,
} from "@/operations/runtime";

// Server-side entry points for the UI. Each re-checks the owner's session:
// server actions are POST endpoints in their own right, and the proxy's
// cookie check alone doesn't honour sign-out (see src/lib/auth/session.ts).
// The actor is fixed to "user" here — the UI never gets to claim to be
// Tally or a rule.

/** Runs `fn` with a transactional database, only for a signed-in owner. For actions that chain an operation with the pipeline. */
export async function asOwner<T>(fn: Parameters<typeof withTransactionalDb<T>>[0]): Promise<T> {
  if (!(await hasValidSession())) throw new Error("Not signed in");
  return withTransactionalDb(fn);
}

export function executeAsOwner(request: Omit<ExecuteRequest, "actor">) {
  return asOwner((db) => execute(db, { ...request, actor: "user" }));
}

export function approveAsOwner(commandId: string) {
  return asOwner((db) => approveProposal(db, commandId, "user"));
}

export function rejectAsOwner(commandId: string) {
  return asOwner((db) => rejectProposal(db, commandId, "user"));
}

export function undoAsOwner(commandId: string) {
  return asOwner((db) => undoCommand(db, commandId, { actor: "user", reason: "Undone from the activity log" }));
}
