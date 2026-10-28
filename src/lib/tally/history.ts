import { inArray } from "drizzle-orm";
import { commandLog } from "@/db/schema";
import type { Db } from "@/db/types";
import { conversationMessages } from "@/lib/tally/agent";

// A stored conversation as the chat shows it, for both the full page and
// the panel (#72), so the two always read it the same way.

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; operation: string; ok: boolean }
  | { kind: "proposal"; commandId: string; operation: string; input: Record<string, unknown>; reason: string; status: string }
  | { kind: "error"; text: string };

export async function conversationItems(db: Db, conversationId: string): Promise<Item[]> {
  const messages = await conversationMessages(db, conversationId);
  // Proposals as they stand now: approved or rejected since, or still waiting.
  const commandIds = messages.map((m) => m.commandId).filter((id): id is string => Boolean(id));
  const commands = commandIds.length
    ? await db
        .select({ id: commandLog.id, operation: commandLog.operation, input: commandLog.input, reason: commandLog.reason, status: commandLog.status })
        .from(commandLog)
        .where(inArray(commandLog.id, commandIds))
    : [];
  const callName = new Map(messages.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name.replace(/__/g, ".")] as const)));
  return messages.flatMap((m): Item[] => {
    if (m.role === "user") return [{ kind: "user", text: m.content ?? "" }];
    if (m.role === "assistant") return m.content ? [{ kind: "assistant", text: m.content }] : [];
    const command = commands.find((c) => c.id === m.commandId);
    if (command) {
      return [{ kind: "proposal", commandId: command.id, operation: command.operation, input: command.input as Record<string, unknown>, reason: command.reason, status: command.status }];
    }
    const ok = !(m.content ?? "").startsWith('{"error"');
    return [{ kind: "tool", operation: callName.get(m.toolCallId ?? "") ?? "a tool", ok }];
  });
}
