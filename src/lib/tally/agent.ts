import { asc, desc, eq } from "drizzle-orm";
import { tallyConversations, tallyMessages } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  chatStream as defaultChatStream,
  ModelError,
  ModelNotConfiguredError,
  ModelUnavailableError,
  type ChatMessage,
  type StreamEvent,
} from "@/lib/model/client";
import { runTool, toolSpecs } from "@/lib/tally/tools";

// One turn with Tally (#11): the owner's message, then as many model rounds
// as it takes — each streamed, each able to call tools — until the model
// answers without calling one. Everything said is stored, so the next turn
// (or a reload) has the thread.

// Enough rounds for "look something up, then look up its details, then
// propose a change"; a model going in circles stops here.
const MAX_ROUNDS = 6;
// Context replayed each turn. Older messages drop off; the system prompt
// and tools are always there. Kept modest so a chat with several lookups
// stays inside the model's 32k context (model/serve.py).
const HISTORY_MESSAGES = 16;

export function systemPrompt(today: string): string {
  return [
    "You are Tally, the assistant inside Data Ledger, the owner's personal finance app. Today is " + today + ".",
    "Answer from the ledger, using your tools; never guess or invent numbers. If the tools can't answer, say so.",
    "Amounts in tool results are already in dollars; quote them exactly as given. A minus sign means money left an account.",
    "When calling a tool, amounts you pass (fields ending in Cents) are integer cents: $45.50 is 4550.",
    "Changes (categorizing, rules, budget targets, goals…) are proposals: the owner approves or rejects each one. After proposing, say what you proposed — never say it's done.",
    "You never see account balances, net worth, investment values or goal progress; if asked, point the owner to the Net worth, Investments or Goals page.",
    "Be brief and plain: a few sentences or a short list. No preamble.",
  ].join("\n");
}

export type TallyEvent =
  | { type: "conversation"; id: string }
  | { type: "waiting"; elapsedMs: number }
  | { type: "delta"; text: string }
  | { type: "tool"; operation: string; kind: "read" | "write" | null; ok: boolean }
  | { type: "proposal"; commandId: string; operation: string; input: Record<string, unknown>; reason: string }
  | { type: "message"; content: string }
  | { type: "error"; message: string }
  | { type: "done" };

type StoredMessage = typeof tallyMessages.$inferSelect;

/** Stored messages in the model's own shape. */
export function toModelMessages(rows: StoredMessage[]): ChatMessage[] {
  return rows.map((m): ChatMessage => {
    if (m.role === "user") return { role: "user", content: m.content ?? "" };
    if (m.role === "tool") return { role: "tool", content: m.content ?? "", tool_call_id: m.toolCallId ?? "" };
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls?.length
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    };
  });
}

async function history(db: Db, conversationId: string): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(tallyMessages)
    .where(eq(tallyMessages.conversationId, conversationId))
    .orderBy(desc(tallyMessages.createdAt))
    .limit(HISTORY_MESSAGES);
  const recent = rows.reverse();
  // Never start mid-exchange: a tool result without the call that asked
  // for it is meaningless to the model.
  while (recent.length && recent[0].role === "tool") recent.shift();
  return recent;
}

export async function* runTurn(
  db: Db,
  { conversationId, text, today = new Date().toISOString().slice(0, 10) }: { conversationId: string | null; text: string; today?: string },
  { chatStream = defaultChatStream }: { chatStream?: typeof defaultChatStream } = {},
): AsyncGenerator<TallyEvent> {
  let id = conversationId;
  if (!id) {
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    [{ id }] = await db.insert(tallyConversations).values({ title }).returning({ id: tallyConversations.id });
  }
  yield { type: "conversation", id: id! };
  await db.insert(tallyMessages).values({ conversationId: id!, role: "user", content: text });
  await db.update(tallyConversations).set({ updatedAt: new Date() }).where(eq(tallyConversations.id, id!));

  const tools = toolSpecs();
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(today) }, ...toModelMessages(await history(db, id!))];
      let done: Extract<StreamEvent, { type: "done" }> | null = null;
      for await (const event of chatStream({ feature: "tally", messages, tools, mode: "interactive", maxTokens: 1_024, temperature: 0.2 }, { db })) {
        if (event.type === "waiting") yield { type: "waiting", elapsedMs: event.elapsedMs };
        else if (event.type === "delta") yield { type: "delta", text: event.text };
        else done = event;
      }
      if (!done) throw new ModelError("The model's reply broke off");

      const calls = done.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
      await db.insert(tallyMessages).values({ conversationId: id!, role: "assistant", content: done.content, toolCalls: calls.length ? calls : null });
      if (calls.length === 0) {
        yield { type: "message", content: done.content ?? "" };
        yield { type: "done" };
        return;
      }
      for (const call of calls) {
        const outcome = await runTool(db, call);
        await db.insert(tallyMessages).values({
          conversationId: id!,
          role: "tool",
          content: outcome.content,
          toolCallId: call.id,
          commandId: outcome.proposal?.commandId ?? null,
        });
        yield { type: "tool", operation: outcome.operation ?? call.name, kind: outcome.kind, ok: outcome.ok };
        if (outcome.proposal) yield { type: "proposal", ...outcome.proposal };
      }
    }
    const stopped = "I stopped there: that took more steps than I allow myself in one go. Ask again more specifically and I'll pick it up.";
    await db.insert(tallyMessages).values({ conversationId: id!, role: "assistant", content: stopped });
    yield { type: "message", content: stopped };
    yield { type: "done" };
  } catch (error) {
    const message =
      error instanceof ModelNotConfiguredError
        ? "Tally needs the model service configured (MODEL_BASE_URL and MODEL_API_KEY)."
        : error instanceof ModelUnavailableError
          ? "The model is still waking up. Send that again in a minute; it'll be quick once it's warm."
          : error instanceof ModelError
            ? error.message
            : "Something went wrong talking to the model.";
    // The expected failures (not configured, still waking, the model's own
    // error) are already explained to the owner; anything else is a bug.
    if (!(error instanceof ModelError || error instanceof ModelNotConfiguredError || error instanceof ModelUnavailableError)) {
      console.error("Tally turn failed", error);
    }
    yield { type: "error", message };
  }
}

export async function listConversations(db: Db, limit = 30) {
  return db
    .select({ id: tallyConversations.id, title: tallyConversations.title, updatedAt: tallyConversations.updatedAt })
    .from(tallyConversations)
    .orderBy(desc(tallyConversations.updatedAt))
    .limit(limit);
}

export async function conversationMessages(db: Db, conversationId: string) {
  return db.select().from(tallyMessages).where(eq(tallyMessages.conversationId, conversationId)).orderBy(asc(tallyMessages.createdAt));
}
