import { inArray } from "drizzle-orm";
import Link from "next/link";
import { commandLog } from "@/db/schema";
import { getDb } from "@/lib/db";
import { modelIsConfigured } from "@/lib/model/client";
import { conversationMessages, listConversations } from "@/lib/tally/agent";
import { Chat, type Item } from "./chat";

// Tally (#11): chat with the app's own self-hosted model, whose tools are
// the operations registry. ?c=<id> opens an earlier conversation.

export default async function TallyPage(props: PageProps<"/tally">) {
  const sp = await props.searchParams;
  const db = getDb();
  const conversations = await listConversations(db);
  const selected = typeof sp.c === "string" && conversations.some((c) => c.id === sp.c) ? sp.c : null;

  let initial: Item[] = [];
  if (selected) {
    const messages = await conversationMessages(db, selected);
    // Proposals as they stand now: approved or rejected since, or still waiting.
    const commandIds = messages.map((m) => m.commandId).filter((id): id is string => Boolean(id));
    const commands = commandIds.length
      ? await db
          .select({ id: commandLog.id, operation: commandLog.operation, input: commandLog.input, reason: commandLog.reason, status: commandLog.status })
          .from(commandLog)
          .where(inArray(commandLog.id, commandIds))
      : [];
    const callName = new Map(messages.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name.replace(/__/g, ".")] as const)));
    initial = messages.flatMap((m): Item[] => {
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

  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <aside className="space-y-2 text-sm">
        <Link href="/tally" className="block font-medium underline-offset-2 hover:underline">
          + New conversation
        </Link>
        <ul className="space-y-1">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/tally?c=${c.id}`}
                className={`block truncate ${c.id === selected ? "font-medium" : "text-muted-foreground hover:text-foreground"}`}
                title={c.title}
              >
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <section className="min-w-0 space-y-3">
        <h1 className="text-2xl font-semibold">Tally</h1>
        {modelIsConfigured() ? (
          // Keyed by conversation, so switching threads starts fresh state.
          <Chat key={selected ?? "new"} conversationId={selected} initial={initial} />
        ) : (
          <p className="text-muted-foreground">Tally needs the model service configured (MODEL_BASE_URL and MODEL_API_KEY in this deployment).</p>
        )}
      </section>
    </div>
  );
}
