import { and, desc, eq } from "drizzle-orm";
import { commandLog, type RowChange } from "@/db/schema";
import type { Db } from "@/db/types";
import type { z } from "zod";
import { isActor, type Actor, type Operation, type ReadOperation, type WriteOperation } from "@/operations/define";
import { getOperation, trackedTables } from "@/operations/registry";
import { WriteContext, currentRow, restoreRow, sameRow } from "@/operations/tracked";

// The one entry point for running operations, whatever the surface. It owns
// the invariants: inputs are validated, writes and their log entry commit in
// one transaction, Tally's writes become proposals, and undo is replayed
// from the log.

export class OperationError extends Error {}

export type ExecuteRequest = {
  operation: string;
  input: unknown;
  actor: Actor;
  // Why this write is happening, in a sentence. Shown in the activity log
  // and to the owner when approving a proposal. Ignored for reads.
  reason: string;
  // Stage a write for approval even if this actor could apply it directly.
  propose?: boolean;
};

export type ExecuteResult =
  | { status: "read"; output: unknown }
  | { status: "applied"; output: unknown; commandId: string }
  | { status: "proposed"; commandId: string };

// Tally proposes; the owner approves (README, decision 3). Promoting an
// operation to auto-apply for Tally is a later, explicit change here — not a
// flag Tally can set on a request.
const AUTO_APPLY_FOR_TALLY = new Set<string>();

function mustPropose(actor: Actor, op: WriteOperation): boolean {
  return actor === "tally" && !AUTO_APPLY_FOR_TALLY.has(op.name);
}

function actorAllowed(allowed: NonNullable<Operation["allowedActors"]>, actor: Actor): boolean {
  return allowed.some((a) => a === actor || (a === "rule:*" && actor.startsWith("rule:")));
}

function resolve(name: string): Operation {
  const op = getOperation(name);
  if (!op) throw new OperationError(`Unknown operation "${name}"`);
  return op;
}

async function applyWrite(tx: Db, op: WriteOperation, input: Record<string, unknown>) {
  const ctx = new WriteContext(tx);
  const output = await op.apply(ctx, input);
  return { output, changes: ctx.changes };
}

/**
 * Runs a read, applies a write, or stages a write as a proposal. Throws a
 * ZodError for invalid input — nothing is logged for a request that never
 * validated.
 *
 * `db` must support transactions (the WebSocket driver or PGlite, not
 * neon-http) when the operation is a write.
 */
export async function execute(db: Db, request: ExecuteRequest): Promise<ExecuteResult> {
  if (!isActor(request.actor)) throw new OperationError(`Invalid actor "${request.actor}"`);
  const op = resolve(request.operation);
  if (op.allowedActors && !actorAllowed(op.allowedActors, request.actor)) {
    throw new OperationError(`${request.actor} may not run ${op.name}`);
  }
  const input = op.input.parse(request.input);

  if (op.kind === "read") return { status: "read", output: await op.run(db, input) };

  const reason = request.reason.trim();
  if (!reason) throw new OperationError("A write needs a reason");

  if (request.propose || mustPropose(request.actor, op)) {
    const [row] = await db
      .insert(commandLog)
      .values({ actor: request.actor, operation: op.name, input, reason, status: "proposed" })
      .returning({ id: commandLog.id });
    return { status: "proposed", commandId: row.id };
  }

  return db.transaction(async (tx) => {
    const { output, changes } = await applyWrite(tx, op, input);
    const [row] = await tx
      .insert(commandLog)
      .values({ actor: request.actor, operation: op.name, input, reason, status: "applied", changes })
      .returning({ id: commandLog.id });
    return { status: "applied" as const, output, commandId: row.id };
  });
}

/**
 * Typed read for server code (pages): same validation as execute(), but
 * returns the operation's own output type instead of `unknown`. Reads
 * aren't logged either way.
 */
export async function read<I extends z.ZodObject, O>(db: Db, op: ReadOperation<I, O>, input: z.input<I>): Promise<O> {
  return op.run(db, op.input.parse(input));
}

async function lockCommand(tx: Db, commandId: string) {
  const [row] = await tx.select().from(commandLog).where(eq(commandLog.id, commandId)).for("update");
  if (!row) throw new OperationError(`Command ${commandId} not found`);
  return row;
}

/**
 * Applies a proposed write now, against current data. The input is
 * re-validated, since the proposal may predate a schema change. If applying
 * fails, the proposal stays open and the error propagates.
 */
export async function approveProposal(db: Db, commandId: string, decidedBy: Actor = "user") {
  return db.transaction(async (tx) => {
    const row = await lockCommand(tx, commandId);
    if (row.status !== "proposed") throw new OperationError(`Command ${commandId} is ${row.status}, not proposed`);
    const op = resolve(row.operation);
    if (op.kind !== "write") throw new OperationError(`${op.name} is not a write`);

    const { output, changes } = await applyWrite(tx, op, op.input.parse(row.input));
    await tx
      .update(commandLog)
      .set({ status: "applied", changes, decidedBy, decidedAt: new Date() })
      .where(eq(commandLog.id, commandId));
    return { output, commandId };
  });
}

export async function rejectProposal(db: Db, commandId: string, decidedBy: Actor = "user") {
  const updated = await db
    .update(commandLog)
    .set({ status: "rejected", decidedBy, decidedAt: new Date() })
    .where(and(eq(commandLog.id, commandId), eq(commandLog.status, "proposed")))
    .returning({ id: commandLog.id });
  if (updated.length === 0) throw new OperationError(`Command ${commandId} is not an open proposal`);
}

export class UndoConflictError extends OperationError {}

const NOUNS: Record<string, string> = {
  transactions: "transaction",
  accounts: "account",
  categories: "category",
  rules: "rule",
  transaction_splits: "split part",
  tags: "tag",
  transaction_tags: "tag",
};

/**
 * Reverses an applied write by restoring every row it touched, in reverse
 * order. Refuses if any of those rows has changed since — undoing over a
 * later edit would silently discard that edit. The undo is logged as its
 * own command, so the history only ever grows.
 */
export async function undoCommand(db: Db, commandId: string, { actor = "user", reason = "Undo" }: { actor?: Actor; reason?: string } = {}) {
  return db.transaction(async (tx) => {
    const row = await lockCommand(tx, commandId);
    if (row.status !== "applied") throw new OperationError(`Command ${commandId} is ${row.status}; only applied writes can be undone`);
    if (row.undoOf) throw new OperationError("An undo can't itself be undone; repeat the original change instead");

    const tableFor = (change: RowChange) => {
      const table = trackedTables[change.table as keyof typeof trackedTables];
      if (!table) throw new OperationError(`Table "${change.table}" isn't registered for undo`);
      return table;
    };

    // Compare each row with its *final* state in this command. One command
    // can touch a row more than once (the sync inserts a posted transaction,
    // then updates it with a pending row's split), and only the last
    // change's `after` is what the row should look like now.
    const finalState = new Map<string, RowChange>();
    for (const change of row.changes) finalState.set(`${change.table}|${change.id}`, change);
    for (const change of finalState.values()) {
      if (!sameRow(await currentRow(tx, tableFor(change), change.id), change.after)) {
        // Shown on the Activity page, so in words rather than a table name
        // and a uuid.
        const noun = NOUNS[change.table] ?? "record";
        throw new UndoConflictError(`A ${noun} this changed has been edited since. Undo the newer change to it first.`);
      }
    }

    const inverse: RowChange[] = [];
    for (const change of [...row.changes].reverse()) {
      await restoreRow(tx, tableFor(change), change.id, change.before);
      inverse.push({ table: change.table, id: change.id, before: change.after, after: change.before });
    }

    const [undo] = await tx
      .insert(commandLog)
      .values({
        actor,
        operation: row.operation,
        input: row.input as object,
        reason,
        status: "applied",
        changes: inverse,
        undoOf: row.id,
      })
      .returning({ id: commandLog.id });
    await tx.update(commandLog).set({ status: "undone", undoneBy: undo.id }).where(eq(commandLog.id, row.id));
    return { commandId: undo.id };
  });
}

export async function listCommands(db: Db, { limit = 50 }: { limit?: number } = {}) {
  return db.select().from(commandLog).orderBy(desc(commandLog.createdAt)).limit(limit);
}
