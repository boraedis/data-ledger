"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { proposalLabel, toolLabel } from "@/lib/tally/format";
import { decide } from "./actions";

// The chat with Tally (#11). A turn streams in as JSON lines from
// /api/tally: "waiting" while the model wakes (a cold start takes minutes,
// so that's shown rather than a frozen spinner), text as it's written,
// tools as they run, and proposals to approve or reject right here.

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; operation: string; ok: boolean }
  | { kind: "proposal"; commandId: string; operation: string; input: Record<string, unknown>; reason: string; status: string }
  | { kind: "error"; text: string };

type Event =
  | { type: "conversation"; id: string }
  | { type: "waiting"; elapsedMs: number }
  | { type: "delta"; text: string }
  | { type: "tool"; operation: string; kind: string | null; ok: boolean }
  | { type: "proposal"; commandId: string; operation: string; input: Record<string, unknown>; reason: string }
  | { type: "message"; content: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** Paragraphs, "- " lists and **bold** — what the model actually writes; no HTML. */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
    );
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}

function ProposalCard({ item, onDecided }: { item: Extract<Item, { kind: "proposal" }>; onDecided: (status: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (approve: boolean) =>
    startTransition(async () => {
      const result = await decide(item.commandId, approve);
      if ("error" in result) setError(result.error);
      else onDecided(result.status);
    });
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Proposed: {proposalLabel(item.operation)}</span>
        <span className="text-xs text-muted-foreground">{item.status === "proposed" ? "waiting for you" : item.status}</span>
      </div>
      {item.reason ? <p className="text-muted-foreground">{item.reason}</p> : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(item.input, null, 2)}</pre>
      </details>
      {item.status === "proposed" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => act(true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(false)}>
            Reject
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function Chat({ conversationId: initialId, initial }: { conversationId: string | null; initial: Item[] }) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialId);
  const [items, setItems] = useState<Item[]>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);

  // A block body on purpose: newer browsers return a Promise from scroll
  // methods, and an effect must return nothing but a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items, waitingSince]);
  useEffect(() => {
    if (waitingSince === null) return;
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [waitingSince]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    setItems((all) => [...all, { kind: "user", text }]);
    let streaming = false;
    const apply = (event: Event) => {
      switch (event.type) {
        case "conversation":
          if (event.id !== conversationId) {
            setConversationId(event.id);
            // The URL follows the conversation without remounting the chat.
            window.history.replaceState(null, "", `/tally?c=${event.id}`);
          }
          break;
        case "waiting":
          setWaitingSince((since) => since ?? Date.now() - event.elapsedMs);
          break;
        case "delta":
          setWaitingSince(null);
          setItems((all) => {
            const last = all.at(-1);
            if (streaming && last?.kind === "assistant") return [...all.slice(0, -1), { kind: "assistant", text: last.text + event.text }];
            streaming = true;
            return [...all, { kind: "assistant", text: event.text }];
          });
          break;
        case "tool":
          setWaitingSince(null);
          streaming = false;
          if (event.kind === "read" || !event.ok) setItems((all) => [...all, { kind: "tool", operation: event.operation, ok: event.ok }]);
          break;
        case "proposal":
          setItems((all) => [...all, { kind: "proposal", ...event, status: "proposed" }]);
          break;
        case "message":
          streaming = false;
          break;
        case "error":
          setWaitingSince(null);
          setItems((all) => [...all, { kind: "error", text: event.message }]);
          break;
      }
    };

    try {
      const response = await fetch("/api/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, text }),
      });
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? "Signed out — sign in again." : `Request failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) apply(JSON.parse(line) as Event);
        }
      }
    } catch (error) {
      setItems((all) => [...all, { kind: "error", text: error instanceof Error ? error.message : "Couldn't reach Tally." }]);
    } finally {
      setWaitingSince(null);
      setBusy(false);
      // The conversation list picks up a new or renamed thread.
      router.refresh();
    }
  }

  const waitedSeconds = waitingSince === null ? 0 : Math.round((Date.now() - waitingSince) / 1000);

  return (
    <div className="flex min-h-[60vh] flex-col gap-3">
      <div className="flex-1 space-y-3">
        {items.length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Ask about your spending, budgets, subscriptions or what you&apos;re owed, or ask for a change. Changes come back as proposals for you to approve.</p>
            <p>Try: &quot;How much did I spend on dining last month?&quot; · &quot;What&apos;s still in my inbox?&quot; · &quot;Make a rule for Corner Bean Cafe → Coffee&quot;</p>
          </div>
        ) : null}
        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
                  {item.text}
                </div>
              );
            case "assistant":
              return item.text.trim() ? (
                <div key={i} className="max-w-[95%] text-sm">
                  <Prose text={item.text} />
                </div>
              ) : null;
            case "tool":
              return (
                <p key={i} className="text-xs text-muted-foreground">
                  {item.ok ? toolLabel(item.operation) : `Couldn't use ${item.operation}`}
                </p>
              );
            case "proposal":
              return (
                <ProposalCard
                  key={item.commandId}
                  item={item}
                  onDecided={(status) => setItems((all) => all.map((x) => (x.kind === "proposal" && x.commandId === item.commandId ? { ...x, status } : x)))}
                />
              );
            case "error":
              return (
                <p key={i} className="text-sm text-destructive">
                  {item.text}
                </p>
              );
          }
        })}
        {waitingSince !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            Waking the model up — {Math.floor(waitedSeconds / 60)}:{String(waitedSeconds % 60).padStart(2, "0")}. It sleeps when idle and
            takes about 3–4 minutes to start; after that, replies are quick.
          </p>
        ) : busy ? (
          <p className="text-sm text-muted-foreground" role="status">
            Thinking…
          </p>
        ) : null}
        <div ref={bottom} />
      </div>
      <form
        className="sticky bottom-0 flex gap-2 bg-background py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Ask Tally…"
          aria-label="Message Tally"
          className="min-w-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={busy || !draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
