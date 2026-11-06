"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { rederiveMerchants, removeNameChoice } from "../actions";
import { privateName } from "@/lib/privacy/names";

// The cleanup preview as the owner shapes it (#305): each before → after
// ticked by default, with its "after" name editable. Apply makes only the
// ticked ones, each under its name, in one undoable command. Unticked ones
// and edited names are remembered for the raw texts behind them, so a sync
// or a later run gives the same; Your choices lists them, to forget one.

export type Example = { key: string; before: string | null; after: string; transactions: number; description: string };

export function CleanupForm({ examples, unlisted }: { examples: Example[]; unlisted: number }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(examples.map((e) => e.key)));
  const [names, setNames] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error: string } | { changed: number } | null>(null);
  const router = useRouter();
  const count = examples.filter((e) => ticked.has(e.key)).reduce((s, e) => s + e.transactions, 0);
  const nameOf = (e: Example) => (names[e.key] ?? e.after).trim();
  const blank = examples.some((e) => ticked.has(e.key) && !nameOf(e));
  const toggle = (key: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (result && "changed" in result)
    return (
      <p role="status" className="text-sm">
        Updated {result.changed} transaction{result.changed === 1 ? "" : "s"}. It&apos;s one change in{" "}
        <Link href="/activity" className="underline">
          Activity
        </Link>{" "}
        and can be undone there.
      </p>
    );

  return (
    <form
      className="space-y-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (blank) return;
        const apply = examples.filter((e) => ticked.has(e.key)).map((e) => ({ before: e.before, after: e.after, ...(nameOf(e) !== e.after ? { name: nameOf(e) } : {}) }));
        const skip = examples.filter((e) => !ticked.has(e.key)).map((e) => ({ before: e.before, after: e.after }));
        start(async () => {
          const r = await rederiveMerchants({ apply, skip });
          setResult("error" in r ? r : { changed: r.changed });
          if (!("error" in r)) router.refresh();
        });
      }}
    >
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">What changes</h2>
          <span className="flex gap-3 text-xs">
            <button type="button" className="underline" onClick={() => setTicked(new Set(examples.map((e) => e.key)))}>
              Tick all
            </button>
            <button type="button" className="underline" onClick={() => setTicked(new Set())}>
              Untick all
            </button>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Untick a change to leave those transactions as they are, or edit the new name. Either is remembered, so syncs and later runs keep it.
        </p>
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Names now and after, most transactions first</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="w-7 pb-1 text-left font-normal">
                <span className="sr-only">Apply</span>
              </th>
              <th scope="col" className="pb-1 text-left font-normal">
                Now
              </th>
              <th scope="col" className="pb-1 text-left font-normal">
                After
              </th>
              <th scope="col" className="w-14 pb-1 text-right font-normal">
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            {examples.map((e) => {
              const on = ticked.has(e.key);
              return (
                <tr key={e.key} className={`border-t align-top ${on ? "" : "text-muted-foreground"}`}>
                  <td className="py-2.5 pr-1">
                    <input type="checkbox" aria-label={`Apply ${e.before ?? "no name"} → ${nameOf(e) || e.after}`} checked={on} onChange={() => toggle(e.key)} className="h-4 w-4" />
                  </td>
                  <td className="py-2 pr-2">
                    <span className="block break-words">{e.before ?? "No name"}</span>
                    <span className="block break-all font-mono text-[11px] text-muted-foreground">{privateName("description", e.description)}</span>
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      aria-label={`New name for ${e.before ?? "no name"}`}
                      value={names[e.key] ?? e.after}
                      onChange={(ev) => setNames((n) => ({ ...n, [e.key]: ev.target.value }))}
                      disabled={!on}
                      maxLength={80}
                      className={`h-8 w-full min-w-0 rounded border bg-background px-2 text-sm ${names[e.key] !== undefined && nameOf(e) !== e.after ? "border-primary font-medium" : ""}`}
                    />
                    {on && !nameOf(e) ? <span className="text-xs text-destructive">Give it a name, or untick it.</span> : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">{e.transactions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unlisted ? <p className="text-xs text-muted-foreground">{unlisted} more transactions in smaller changes aren&apos;t listed; run it again after this to see them.</p> : null}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || blank || (count === 0 && ticked.size === examples.length)}>
          {pending ? "Applying…" : count ? `Apply to ${count} transaction${count === 1 ? "" : "s"}` : "Remember these choices"}
        </Button>
        {result && "error" in result ? <span className="text-sm text-destructive">{result.error}</span> : null}
      </div>
    </form>
  );
}

export function ChoiceList({ choices }: { choices: { id: string; source: string; name: string; transactions: number }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">Your choices</h2>
      <p className="text-xs text-muted-foreground">
        Names you chose, or kept, for exactly these bank texts. The cleanup and syncs use them instead of their own. Forget one and the next run
        shows what the cleanup would make of it.
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {choices.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
            <span className="min-w-0">
              <span className="block break-all font-mono text-[11px] text-muted-foreground">{c.source}</span>
              <span className="block">
                → {privateName("merchant", c.name)} <span className="text-xs text-muted-foreground tabular-nums">· {c.transactions}</span>
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await removeNameChoice(c.id);
                  setError("error" in r ? r.error : null);
                  router.refresh();
                })
              }
            >
              Forget
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
