"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TradeRow } from "@/operations/trades";
import { setKind, splitDraft } from "./actions";
import { KIND_LABELS, positive, select, type TradeKind } from "./fields";

// What a draft really is, and splitting a net change (#324). A change in
// shares isn't always a trade: a split, a reinvested dividend, a transfer
// between your accounts or a fee paid in shares. And one gap between two
// syncs can be several trades: split it into parts that add up.

const KINDS = Object.keys(KIND_LABELS) as TradeKind[];

export function KindControls({ trade: t }: { trade: TradeRow }) {
  const [open, setOpen] = useState<"kind" | "split" | null>(null);
  const [kind, setKindValue] = useState<TradeKind>(t.kind);
  const [ratio, setRatio] = useState(t.ratio ?? "");
  const [parts, setParts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const saveKind = () => {
    if (kind === "split" && !positive(ratio)) return setError("A split needs its ratio: new shares per old, like 2 for 2-for-1");
    startTransition(async () => {
      const result = await setKind(t.id, t.symbol, kind, kind === "split" ? positive(ratio)! : undefined);
      setError(result?.error ?? null);
      if (!result?.error) setOpen(null);
    });
  };
  const saveSplit = () => {
    const quantities = parts.split(/[\s,;+]+/).filter(Boolean);
    const clean = quantities.map(positive);
    if (clean.length < 2 || clean.some((q) => !q)) return setError("Give two or more quantities, like 1.5, 0.5");
    startTransition(async () => {
      const result = await splitDraft(t.id, t.symbol, clean as string[]);
      setError(result?.error ?? null);
      if (!result?.error) setOpen(null);
    });
  };

  return (
    <div className="space-y-1 text-xs">
      <p className="flex flex-wrap gap-3 text-muted-foreground">
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(open === "kind" ? null : "kind")}>
          {open === "kind" ? "Cancel" : `Not a plain trade? (now: ${KIND_LABELS[t.kind].toLowerCase()})`}
        </button>
        {t.kind !== "split" && t.kind !== "transfer" ? (
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(open === "split" ? null : "split")}>
            {open === "split" ? "Cancel" : "More than one trade? Split it"}
          </button>
        ) : null}
      </p>
      {open === "kind" ? (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Kind" value={kind} onChange={(e) => setKindValue(e.target.value as TradeKind)} className={select}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {kind === "split" ? (
            <Input aria-label="New shares per old" value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="decimal" placeholder="Ratio, e.g. 2" className="h-8 w-28" />
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={saveKind} disabled={pending}>
            Save kind
          </Button>
          <span className="text-muted-foreground">Dismiss it if it isn&apos;t a change in shares at all.</span>
        </div>
      ) : null}
      {open === "split" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Quantities of each part" value={parts} onChange={(e) => setParts(e.target.value)} placeholder={`Parts adding up to ${t.quantity}`} className="h-8 w-56" />
          <Button type="button" size="sm" variant="outline" onClick={saveSplit} disabled={pending}>
            Split
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
