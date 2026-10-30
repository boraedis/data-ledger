"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { reapplyRule } from "../actions";

// One rule's re-apply preview (#100): every transaction it would change,
// old and new category, ticked unless it's something the owner should
// decide on. Nothing is written until Apply, and then only what's ticked.

export type Change = {
  transactionId: string;
  postedOn: string;
  accountName: string;
  description: string;
  amountCents: number;
  fromCategoryName: string;
  toCategoryName: string;
  skipReason: string | null;
};

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function ReapplyPreview({ ruleId, ruleLabel, changes }: { ruleId: string; ruleLabel: string; changes: Change[] }) {
  const router = useRouter();
  const [ticked, setTicked] = useState(() => new Set(changes.filter((c) => c.skipReason === null).map((c) => c.transactionId)));
  const [result, setResult] = useState<{ error: string } | { ok: true; message?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const chosen = changes.filter((c) => ticked.has(c.transactionId));
  const total = chosen.reduce((sum, c) => sum + c.amountCents, 0);
  const left = changes.filter((c) => c.skipReason !== null);

  const apply = () =>
    startTransition(async () => {
      const r = await reapplyRule(ruleId, [...ticked], ruleLabel);
      setResult(r);
      if (!("error" in r)) router.refresh();
    });

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {changes.length} transaction{changes.length === 1 ? "" : "s"} would change.
        {left.length ? ` ${left.length} ${left.length === 1 ? "is" : "are"} left out unless you tick ${left.length === 1 ? "it" : "them"}.` : ""}
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {changes.map((c) => (
          <li key={c.transactionId}>
            <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/40">
              <input
                type="checkbox"
                className="mt-1"
                checked={ticked.has(c.transactionId)}
                onChange={(e) => toggle(c.transactionId, e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap justify-between gap-x-3">
                  <span className="truncate">{c.description}</span>
                  <span className="tabular-nums">{formatCents(c.amountCents)}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {day(c.postedOn)} · {c.accountName} · {c.fromCategoryName} → <span className="text-foreground">{c.toCategoryName}</span>
                  {c.skipReason ? <span className="text-warning"> · {c.skipReason}</span> : null}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={apply} disabled={pending || chosen.length === 0}>
          Apply to {chosen.length} transaction{chosen.length === 1 ? "" : "s"}
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">Total {formatCents(total)}</span>
      </div>
      <p className="text-xs text-muted-foreground">One entry in Activity, undone together.</p>
      {result ? (
        "error" in result ? <p className="text-sm text-destructive">{result.error}</p> : <p className="text-sm text-muted-foreground">{result.message}</p>
      ) : null}
    </div>
  );
}
