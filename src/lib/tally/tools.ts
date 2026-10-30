import { z } from "zod";
import type { Db } from "@/db/types";
import type { ToolSpec } from "@/lib/model/client";
import { toolResult } from "@/lib/model/redact";
import { formatCents } from "@/lib/money";
import type { Operation } from "@/operations/define";
import { operations } from "@/operations/registry";
import { execute } from "@/operations/runtime";

// Tally's tools are the operations registry (#11): every operation Tally
// may run, with its own description and input schema. Nothing is
// hand-written per tool, so a new operation is a new tool.
//
// The boundary rules live here:
// - Operations restricted to other actors (the sync's import, the
//   pipeline's batches) aren't offered at all.
// - Reads run immediately. Writes run as actor "tally", which the runtime
//   always turns into a proposal for the owner — nothing Tally does changes
//   the books until the owner approves it.
// - Every result passes through toolResult(): redacted of sensitive keys,
//   then capped in size so one big list can't crowd out the conversation.
//   Balances never reach here in the first place: net worth, investments
//   and goal progress aren't operations.

// Function names allow letters, digits, _ and -: "transactions.list" →
// "transactions__list".
export const toolName = (op: Operation) => op.name.replace(/\./g, "__");

// Small on purpose: six rounds of results, plus replayed history, must fit
// the model's 32k context (model/serve.py) with the tool schemas and the
// reply. A bigger cap tipped long chats into HTTP 400.
export const MAX_RESULT_CHARS = 4_000;

export function tallyOperations(): Operation[] {
  return operations.filter((op) => !op.allowedActors || op.allowedActors.includes("tally"));
}

export function toolSpecs(): ToolSpec[] {
  return tallyOperations().map((op) => {
    const schema = z.toJSONSchema(op.input, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    if (op.kind === "write") {
      // Every write needs a reason for the command log; the model writes
      // it, in a sentence the owner will read on the proposal.
      const properties = { ...(schema.properties as Record<string, unknown>), reason: { type: "string", description: "One short sentence for the owner: why make this change." } };
      schema.properties = properties;
      schema.required = [...((schema.required as string[]) ?? []), "reason"];
    }
    return {
      name: toolName(op),
      description: op.kind === "write" ? `${op.description} (A change: it becomes a proposal the owner approves or rejects.)` : op.description,
      parameters: schema,
    };
  });
}

export type ToolOutcome = {
  // What the model sees, already redacted and capped.
  content: string;
  operation: string | null;
  kind: "read" | "write" | null;
  ok: boolean;
  proposal?: { commandId: string; operation: string; input: Record<string, unknown>; reason: string };
};

/**
 * Money as the model should read it: every `…Cents` integer becomes a
 * formatted dollar string under the same name minus "Cents"
 * (`amountCents: -1299` → `amount: "-$12.99"`). Left as cents, the model
 * did the division itself and got it wrong ($13.00 for $12.99), so it's
 * never asked to.
 */
export function moneyForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(moneyForModel);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) =>
        /Cents$/.test(key) && typeof v === "number" ? [key.replace(/Cents$/, ""), formatCents(v)] : [key, moneyForModel(v)],
      ),
    );
  }
  return value;
}

function cap(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [cut off: ${text.length - MAX_RESULT_CHARS} more characters. Narrow the request (a date range, a limit, a filter) for the rest.]`;
}

export async function runTool(db: Db, call: { name: string; arguments: string }): Promise<ToolOutcome> {
  const op = tallyOperations().find((o) => toolName(o) === call.name);
  if (!op) return { content: toolResult({ error: `There's no tool called ${call.name}.` }), operation: null, kind: null, ok: false };

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { content: toolResult({ error: "The arguments weren't valid JSON." }), operation: op.name, kind: op.kind, ok: false };
  }
  const { reason, ...input } = args;

  try {
    const result = await execute(db, {
      operation: op.name,
      input,
      actor: "tally",
      reason: typeof reason === "string" && reason.trim() ? reason.trim() : `Suggested by Tally`,
    });
    if (result.status === "proposed") {
      const parsedInput = op.input.parse(input) as Record<string, unknown>;
      return {
        content: toolResult({
          status: "proposed",
          commandId: result.commandId,
          note: "Not applied yet: the owner sees this as a proposal and approves or rejects it. Say what you proposed; don't claim it's done.",
        }),
        operation: op.name,
        kind: "write",
        ok: true,
        proposal: { commandId: result.commandId, operation: op.name, input: parsedInput, reason: typeof reason === "string" ? reason : "" },
      };
    }
    return { content: cap(toolResult(moneyForModel("output" in result ? result.output : null))), operation: op.name, kind: op.kind, ok: true };
  } catch (error) {
    // Validation and rule errors go back to the model so it can correct
    // itself; their messages are ours, never a database's internals.
    const message =
      error instanceof z.ZodError
        ? `Invalid input: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`
        : error instanceof Error
          ? error.message
          : "The tool failed.";
    return { content: toolResult({ error: message }), operation: op.name, kind: op.kind, ok: false };
  }
}
