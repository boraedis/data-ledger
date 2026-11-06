"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { decideTypeSuggestion, suggestTypes } from "./actions";
import { privateName } from "@/lib/privacy/names";

// Merchant types (#293): suggestions waiting for the owner, each with where
// it came from (the usual category, or the model from the name, with its
// confidence), to approve or reject one by one; and the button that asks
// for more. Nothing is typed without the owner's yes, and a type the owner
// set is never changed.

export type TypeSuggestion = { commandId: string; merchantId: string; merchantName: string; typeName: string; source: "category" | "name"; reason: string };

/** Without `untyped` (on the Inbox, #303) it lists what's waiting, with no button to ask for more. */
export function TypeSuggestions({ suggestions, untyped }: { suggestions: TypeSuggestion[]; untyped?: number }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const act = (fn: () => Promise<{ error: string } | ({ ok: true } & Record<string, unknown>)>, done?: (r: Record<string, unknown>) => string | null) =>
    start(async () => {
      const r = await fn();
      setMessage("error" in r ? String(r.error) : (done?.(r) ?? null));
      router.refresh();
    });
  if (!suggestions.length && !untyped) return null;

  return (
    <section aria-label="Merchant types" className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {untyped === undefined ? (
            <>Suggested merchant types · {suggestions.length}</>
          ) : (
            <>
              Types{" "}
              <span className="font-normal text-muted-foreground">
                ·{" "}
                <Link href="/merchants?type=none" className="underline">
                  {untyped} merchant{untyped === 1 ? "" : "s"} without one
                </Link>
              </span>
            </>
          )}
        </h2>
        {untyped ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(suggestTypes, (r) =>
                `${Number(r.fromCategory) + Number(r.fromModel)} suggested: ${r.fromCategory} from their usual category, ${r.fromModel} from their name` +
                (r.modelOff ? " (the model isn't set up, so names weren't asked about)" : r.error ? ` (the model stopped: ${r.error})` : "") +
                ".",
              )
            }
          >
            {pending ? "Suggesting…" : "Suggest types"}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        From a merchant&apos;s usual category, or from its name by the app&apos;s own model (names only, nothing else). Unsure ones aren&apos;t suggested.
      </p>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {suggestions.length ? (
        <ul className="divide-y text-sm">
          {suggestions.map((s) => (
            <li key={s.commandId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="min-w-0">
                <span className="font-medium">{privateName("merchant", s.merchantName)}</span> → {s.typeName}
                <span className="block text-xs text-muted-foreground">{s.reason.replace(/^Suggested type for .*?: /, "")}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Button size="sm" disabled={pending} onClick={() => act(() => decideTypeSuggestion(s.commandId, true))}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => decideTypeSuggestion(s.commandId, false))}>
                  Reject
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
