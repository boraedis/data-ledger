"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { dismissMerge, mergeMerchants } from "./actions";

// Possible duplicates (#287), above the list: each pair with the evidence
// side by side (names, how the bank wrote them, where and how much), and a
// one-tap merge or "Not the same". Merging keeps the one with more
// transactions; either is undoable in Activity. Nothing merges unasked.

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
  // The one with more transactions stays, with its name.
  const [keep, gone] = s.b.transactions > s.a.transactions ? [s.b, s.a] : [s.a, s.b];
  const act = (fn: () => Promise<{ error: string } | { ok: true }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) setError(r.error);
      else router.refresh();
    });
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <p className="text-xs text-muted-foreground">{s.reason}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Evidence side={s.a} />
        <Evidence side={s.b} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => act(() => mergeMerchants(keep.id, gone.id))}>
          Merge, keeping &ldquo;{keep.name}&rdquo;
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => dismissMerge(s.a.id, s.b.id))}>
          Not the same
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
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
