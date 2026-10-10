import type { z } from "zod";
import type { Db } from "@/db/types";
import type { WriteContext } from "@/operations/tracked";

// Who caused a write. Recorded on every command-log row.
//   user      — the owner, through the UI
//   tally     — the assistant; its writes are proposals unless promoted
//   import    — the nightly sync bringing in bank data
//   rule:<id> — a categorization rule firing
//   memory    — merchant memory: "categorized like this merchant was before"
//   model     — the self-hosted model's confident categorizations (#6)
export type Actor = "user" | "tally" | "import" | "memory" | "model" | `rule:${string}`;

const NAMED_ACTORS = new Set(["user", "tally", "import", "memory", "model"]);

export function isActor(value: string): value is Actor {
  return NAMED_ACTORS.has(value) || /^rule:[\w-]+$/.test(value);
}

// Inputs are always objects: tool calling (Tally) needs an
// object schema, and named fields keep the log readable.
type Base<I extends z.ZodObject> = {
  // Dotted noun.verb, e.g. "transactions.setCategory". Stable: it's stored
  // in the log and becomes Tally's tool name.
  name: string;
  // Written for a model as much as a person — this is what Tally sees when
  // deciding which tool to call.
  description: string;
  input: I;
  // Restricts who may run this operation at all. Unset means anyone. The
  // import operation, for example, is only for the sync — not something the
  // owner or Tally should invoke with hand-made "bank data". "rule:*"
  // allows every rule actor.
  allowedActors?: (Actor | "rule:*")[];
};

export type ReadOperation<I extends z.ZodObject = z.ZodObject, O = unknown> = Base<I> & {
  kind: "read";
  run: (db: Db, input: z.infer<I>) => Promise<O>;
};

export type WriteOperation<I extends z.ZodObject = z.ZodObject, O = unknown> = Base<I> & {
  kind: "write";
  // Gets a WriteContext, not a raw database handle for writing: every change
  // goes through its tracked insert/update/remove, which is what gives every
  // write operation undo without per-operation undo code.
  apply: (ctx: WriteContext, input: z.infer<I>) => Promise<O>;
};

export type Operation = ReadOperation | WriteOperation;

// Identity helpers that exist only so TypeScript infers the handler's input
// type from the schema.
export function defineRead<I extends z.ZodObject, O>(op: Omit<ReadOperation<I, O>, "kind">): ReadOperation<I, O> {
  return { ...op, kind: "read" };
}

export function defineWrite<I extends z.ZodObject, O>(op: Omit<WriteOperation<I, O>, "kind">): WriteOperation<I, O> {
  return { ...op, kind: "write" };
}
