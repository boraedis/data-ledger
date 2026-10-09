import type { z } from "zod";
import type { Db } from "@/db/types";
import type { WriteContext } from "@/operations/tracked";

// Who caused a write. Recorded on every command-log row.
//   user      — the owner, through the UI
//   tally     — the assistant; its writes are proposals unless promoted
//   import    — the nightly sync bringing in bank data
//   rule:<id> — a categorization rule firing
export type Actor = "user" | "tally" | "import" | `rule:${string}`;

export function isActor(value: string): value is Actor {
  return value === "user" || value === "tally" || value === "import" || /^rule:[\w-]+$/.test(value);
}

type Base<I extends z.ZodType> = {
  // Dotted noun.verb, e.g. "transactions.setCategory". Stable: it's stored
  // in the log and becomes the tool name for Tally and MCP.
  name: string;
  // Written for a model as much as a person — this is what Tally and the
  // MCP client see when deciding which tool to call.
  description: string;
  input: I;
};

export type ReadOperation<I extends z.ZodType = z.ZodType, O = unknown> = Base<I> & {
  kind: "read";
  run: (db: Db, input: z.infer<I>) => Promise<O>;
};

export type WriteOperation<I extends z.ZodType = z.ZodType, O = unknown> = Base<I> & {
  kind: "write";
  // Gets a WriteContext, not a raw database handle for writing: every change
  // goes through its tracked insert/update/remove, which is what gives every
  // write operation undo without per-operation undo code.
  apply: (ctx: WriteContext, input: z.infer<I>) => Promise<O>;
};

export type Operation = ReadOperation | WriteOperation;

// Identity helpers that exist only so TypeScript infers the handler's input
// type from the schema.
export function defineRead<I extends z.ZodType, O>(op: Omit<ReadOperation<I, O>, "kind">): ReadOperation<I, O> {
  return { ...op, kind: "read" };
}

export function defineWrite<I extends z.ZodType, O>(op: Omit<WriteOperation<I, O>, "kind">): WriteOperation<I, O> {
  return { ...op, kind: "write" };
}
