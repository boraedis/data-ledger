import Link from "next/link";
import { getDb } from "@/lib/db";
import { modelIsConfigured } from "@/lib/model/client";
import { listConversations } from "@/lib/tally/agent";
import { conversationItems } from "@/lib/tally/history";
import { Chat } from "./chat";

// Tally (#11): chat with the app's own self-hosted model, whose tools are
// the operations registry. ?c=<id> opens an earlier conversation.

export default async function TallyPage(props: PageProps<"/tally">) {
  const sp = await props.searchParams;
  const db = getDb();
  const conversations = await listConversations(db);
  const selected = typeof sp.c === "string" && conversations.some((c) => c.id === sp.c) ? sp.c : null;

  const initial = selected ? await conversationItems(db, selected) : [];

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
