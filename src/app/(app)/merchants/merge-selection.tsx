"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { mergeSeveral } from "./actions";
import { privateName } from "@/lib/privacy/names";

// Merging several merchants at once from the list (#304): tick them, pick
// the one to keep (the one with most transactions by default) and the name,
// and they become one merchant in one undoable command. The table itself
// stays server-rendered; only the ticks and the bar are client-side.

type Choice = { id: string; name: string; transactions: number };
const Selection = createContext<{ selected: Set<string>; toggle: (id: string) => void } | null>(null);

export function MergeSelection({ merchants, children }: { merchants: Choice[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Only ones still listed: a search can hide a ticked one, which then isn't merged.
  const picked = merchants.filter((m) => selected.has(m.id));
  return (
    <Selection.Provider value={{ selected, toggle }}>
      {children}
      {picked.length >= 2 ? <MergeBar key={picked.map((p) => p.id).join(",")} picked={picked} onDone={() => setSelected(new Set())} /> : null}
    </Selection.Provider>
  );
}

export function SelectBox({ id, name }: { id: string; name: string }) {
  const ctx = useContext(Selection);
  if (!ctx) return null;
  return <input type="checkbox" aria-label={`Select ${name} to merge`} checked={ctx.selected.has(id)} onChange={() => ctx.toggle(id)} className="h-4 w-4" />;
}

function MergeBar({ picked, onDone }: { picked: Choice[]; onDone: () => void }) {
  const [keepId, setKeepId] = useState([...picked].sort((a, b) => b.transactions - a.transactions)[0].id);
  const keep = picked.find((p) => p.id === keepId)!;
  const [typed, setTyped] = useState<string | null>(null);
  const name = (typed ?? keep.name).trim();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div role="region" aria-label="Merge the selected merchants" className="sticky bottom-2 z-10 flex flex-wrap items-end gap-2 rounded-lg border bg-background p-3 text-sm shadow-md">
      <p className="basis-full text-xs text-muted-foreground">
        {picked.length} selected: their names and transactions become one merchant. Undo it in Activity.
      </p>
      <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
        Keep
        <select value={keepId} onChange={(e) => setKeepId(e.target.value)} className="h-9 rounded border bg-background px-2 text-sm text-foreground">
          {picked.map((p) => (
            <option key={p.id} value={p.id}>
              {privateName("merchant", p.name)} ({p.transactions})
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
        Merged name
        <input
          value={typed ?? keep.name}
          onChange={(e) => setTyped(e.target.value)}
          list="merge-several-names"
          maxLength={80}
          className="h-9 min-w-0 rounded border bg-background px-2 text-sm text-foreground sm:w-56"
        />
        <datalist id="merge-several-names">
          {picked.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </label>
      <Button
        disabled={pending || !name}
        onClick={() =>
          start(async () => {
            const r = await mergeSeveral(keep.id, picked.filter((p) => p.id !== keep.id).map((p) => p.id), name === keep.name ? undefined : name);
            if ("error" in r) return setError(r.error);
            onDone();
            router.refresh();
          })
        }
      >
        Merge {picked.length} as &ldquo;{name || keep.name}&rdquo;
      </Button>
      <Button variant="ghost" disabled={pending} onClick={onDone}>
        Clear
      </Button>
      {error ? <p className="basis-full text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
