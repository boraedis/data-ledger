"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { dismissMerge, mergeMerchants } from "./actions";

// Possible duplicates (#287), above the list: each pair with the evidence
// side by side (names, how the bank wrote them, where and how much), and a
// merge or "Not the same". The owner picks which to keep (the one with more
// transactions by default) and the merged name (#304); either is undoable
// in Activity. Nothing merges unasked.

export type Side = {
  id: string;
  name: string;
  names: string[];
  descriptions: string[];
  transactions: number;
  amountCents: number;
  accounts: string[];
  lastOn: string | null;
};
export type Suggestion = { reason: string; a: Side; b: Side };

const day = (on: string) => new Date(`${on}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Evidence({ side }: { side: Side }) {
  return (
    <div className="min-w-0 space-y-1">
      <Link href={`/merchants/${side.id}`} className="block truncate font-medium underline-offset-2 hover:underline">
        {side.name}
      </Link>
      <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
        {side.descriptions.map((d) => (
          <li key={d} className="break-all">
            {d}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums">
        {side.transactions} transaction{side.transactions === 1 ? "" : "s"}, {formatCents(side.amountCents)}
        {side.lastOn ? `, last ${day(side.lastOn)}` : ""}
        {side.accounts.length ? <span className="block">{side.accounts.join(", ")}</span> : null}
      </p>
    </div>
  );
}

function Pair({ s }: { s: Suggestion }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Which one stays (#304): the one with more transactions unless the owner
  // picks the other. The name is the kept one's until they type another.
  const [keepId, setKeepId] = useState(s.b.transactions > s.a.transactions ? s.b.id : s.a.id);
  const [typed, setTyped] = useState<string | null>(null);
  const [keep, gone] = keepId === s.a.id ? [s.a, s.b] : [s.b, s.a];
  const name = (typed ?? keep.name).trim();
  const act = (fn: () => Promise<{ error: string } | { ok: true }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) setError(r.error);
      else router.refresh();
    });
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <p className="text-xs text-muted-foreground">{s.reason}</p>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Which to keep</legend>
        {[s.a, s.b].map((side) => (
          <label key={side.id} className={`flex gap-2 rounded border p-2 ${keepId === side.id ? "border-primary" : "border-transparent"}`}>
            <input type="radio" name={`keep-${s.a.id}-${s.b.id}`} className="mt-1" checked={keepId === side.id} onChange={() => setKeepId(side.id)} />
            <span className="min-w-0 flex-1">
              <span className="sr-only">Keep </span>
              <Evidence side={side} />
            </span>
          </label>
        ))}
      </fieldset>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) act(() => mergeMerchants(keep.id, gone.id, name === keep.name ? undefined : name));
        }}
      >
        <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
          Merged name
          <input
            value={typed ?? keep.name}
            onChange={(e) => setTyped(e.target.value)}
            maxLength={80}
            className="h-8 min-w-0 rounded border bg-background px-2 text-sm text-foreground sm:w-56"
          />
        </label>
        <Button type="submit" size="sm" disabled={pending || !name}>
          Merge as &ldquo;{name || keep.name}&rdquo;
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(() => dismissMerge(s.a.id, s.b.id))}>
          Not the same
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </form>
    </li>
  );
}

export function MergeSuggestions({ suggestions, total }: { suggestions: Suggestion[]; total: number }) {
  return (
    <section aria-label="Possible duplicates" className="space-y-2">
      <h2 className="text-lg font-medium">
        Possible duplicates <span className="text-sm font-normal text-muted-foreground">· {total}</span>
      </h2>
      <p className="text-xs text-muted-foreground">
        Merchants that look like one business written two ways. Merging moves one&apos;s names and transactions to the other; it&apos;s undoable in
        Activity.{total > suggestions.length ? ` The first ${suggestions.length} are shown.` : ""}
      </p>
      <ul className="divide-y rounded-lg border">
        {suggestions.map((s) => (
          <Pair key={`${s.a.id}|${s.b.id}`} s={s} />
        ))}
      </ul>
    </section>
  );
}
