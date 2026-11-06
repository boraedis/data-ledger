"use client";

import { useRouter } from "next/navigation";
import { createContext, Fragment, useCallback, useContext, useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { setPrivacyMode } from "@/app/(app)/privacy-actions";
import { isPrivacyShortcut, PRIVACY_SHORTCUT_LABEL } from "@/lib/privacy/mode";
import { setBrowserPrivacy } from "@/lib/privacy/state";

// Privacy mode for client components (#363): whether it's on, as the
// layout read it from the cookie, and a way to switch it. The bar across
// the top while it's on lives here too, so no page can show without it.

type Privacy = { on: boolean; pending: boolean; toggle: () => void };

const PrivacyContext = createContext<Privacy>({ on: false, pending: false, toggle: () => {} });

/** Whether privacy mode is on, and a way to switch it. The one way client components ask. */
export const usePrivacy = () => useContext(PrivacyContext);

// True in the browser once hydrated, false on the server and while hydrating.
const subscribeNever = () => () => {};
const useInBrowser = () => useSyncExternalStore(subscribeNever, () => true, () => false);

export function PrivacyProvider({ on, children }: { on: boolean; children: React.ReactNode }) {
  // Before any child renders, so every figure formatted in this tab masks or doesn't (#364).
  if (typeof window !== "undefined") setBrowserPrivacy(on);
  const inBrowser = useInBrowser();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(
    () =>
      startTransition(async () => {
        const result = await setPrivacyMode(!on);
        if ("error" in result) setError(result.error);
        else {
          setError(null);
          // Everything rendered on the server follows the cookie on the next render.
          router.refresh();
        }
      }),
    [on, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPrivacyShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <PrivacyContext.Provider value={{ on, pending, toggle }}>
      {on ? (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/40 bg-primary/10 px-4 py-1.5 text-sm">
          <span className="font-medium">Privacy mode is on</span>
          <span className="text-muted-foreground">Amounts and names are hidden on this browser. {PRIVACY_SHORTCUT_LABEL} switches it.</span>
          <button type="button" className="ml-auto underline" disabled={pending} onClick={toggle}>
            Turn off
          </button>
        </div>
      ) : null}
      {error ? <p className="border-b bg-destructive/10 px-4 py-1.5 text-sm text-destructive">Couldn&apos;t switch privacy mode: {error}</p> : null}
      {/* While it's on, the page isn't rendered on the server, only in the
          browser, where the mode is exact (lib/privacy/state.ts): the
          server can't mask client components' figures per request. Keyed
          on the mode so switching it renders every figure again. The
          wrapper's attribute is what masks amount inputs (globals.css). */}
      {on && !inBrowser ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Loading in privacy mode…</p>
      ) : (
        <Fragment key={on ? "private" : "plain"}>
          <div data-privacy={on ? "on" : undefined} className="contents">
            {children}
          </div>
        </Fragment>
      )}
    </PrivacyContext.Provider>
  );
}
