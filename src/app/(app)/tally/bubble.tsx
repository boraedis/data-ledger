"use client";

import { MessageCircle, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Item } from "@/lib/tally/history";
import { panelConversation } from "./actions";
import { Chat } from "./chat";

// Tally on every page (#72): a button in the bottom-right corner that opens
// the chat in a panel over the page. Same /api/tally stream, same stored
// conversations as /tally, so a thread moves between the two freely.
//
// The panel stays mounted once opened, only hidden, so closing it or moving
// to another page doesn't cut off a reply that's still streaming in. On a
// phone it fills the screen: a corner panel there would be too small to
// read and would cover the page anyway.

type Loaded = { conversationId: string | null; items: Item[]; key: number };

export function TallyBubble({ configured }: { configured: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // The full page is the chat already; no bubble over it.
  const onTallyPage = pathname === "/tally";
  const visible = open && !onTallyPage;

  // Focus into the panel on open (the message box once it's there), and
  // back to the button on close.
  useEffect(() => {
    if (visible) (panel.current?.querySelector("textarea") ?? panel.current)?.focus();
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = visible;
  }, [visible, loaded?.key]);

  function show() {
    setOpen(true);
    // Mid-reply, keep what's on screen. Otherwise re-read, so what was said
    // on /tally since shows here. (A "New" conversation not yet sent has
    // nothing to lose; reopening goes back to the latest thread.)
    if (!configured || busy) return;
    startLoading(async () => {
      try {
        const next = await panelConversation();
        setLoaded((prev) => ({ ...next, key: (prev?.key ?? 0) + 1 }));
        setError(null);
      } catch {
        setError("Couldn't load the conversation.");
      }
    });
  }

  const startNew = () => setLoaded((prev) => ({ conversationId: null, items: [], key: (prev?.key ?? 0) + 1 }));
  const fullPage = loaded?.conversationId ? `/tally?c=${loaded.conversationId}` : "/tally";

  if (onTallyPage && !loaded) return null;

  return (
    <>
      <div
        ref={panel}
        id="tally-panel"
        role="dialog"
        aria-labelledby="tally-panel-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={`${visible ? "flex" : "hidden"} fixed inset-0 z-40 flex-col bg-background outline-none sm:inset-auto sm:right-4 sm:bottom-20 sm:h-[min(36rem,calc(100svh-7rem))] sm:w-96 sm:rounded-lg sm:border sm:shadow-lg`}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <h2 id="tally-panel-title" className="text-lg">
            Tally
          </h2>
          <div className="flex items-center gap-3 text-sm">
            {configured ? (
              <>
                <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={busy || loading} onClick={startNew}>
                  New
                </button>
                <Link href={fullPage} className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
                  Open full page
                </Link>
              </>
            ) : null}
            <button type="button" aria-label="Close Tally" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        {!configured ? (
          <p className="p-4 text-sm text-muted-foreground">Tally needs the model service configured (MODEL_BASE_URL and MODEL_API_KEY in this deployment).</p>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : loaded ? (
          <Chat
            key={loaded.key}
            variant="panel"
            conversationId={loaded.conversationId}
            initial={loaded.items}
            onConversation={(id) => setLoaded((prev) => prev && { ...prev, conversationId: id })}
            onBusyChange={setBusy}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground" role="status">
            Loading…
          </p>
        )}
      </div>

      {onTallyPage ? null : (
        <button
          ref={button}
          type="button"
          aria-label={open ? "Close Tally" : "Chat with Tally"}
          aria-expanded={open}
          aria-controls="tally-panel"
          onClick={() => (open ? setOpen(false) : show())}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          // Hidden under the full-screen panel on a phone, which has its
          // own close button. The safe-area guard only matters if the app
          // ever draws under the home indicator (viewport-fit=cover).
          className={`${open ? "hidden sm:flex" : "flex"} fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none`}
        >
          {open ? <X className="size-5" aria-hidden /> : <MessageCircle className="size-5" aria-hidden />}
          {busy && !open ? <span className="absolute top-0 right-0 size-3 animate-pulse rounded-full border-2 border-background bg-warning" aria-hidden /> : null}
        </button>
      )}
    </>
  );
}
