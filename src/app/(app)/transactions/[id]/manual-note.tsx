"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/money";
import { toCents } from "../new/add-form";
import { deleteManual, keepManual, mergeManual, updateManual } from "./actions";

// On a transaction added by hand (#64): that it was, a way to correct or
// delete it, and, when the bank seems to have reported it too, the choice
// between merging and keeping both. Nothing merges without this.

type Candidate = { id: string; postedOn: string; amountCents: number; description: string };

export function ManualNote({
  txn,
  candidates,
  today,
}: {
  txn: { id: string; postedOn: string; amountCents: number; description: string };
  candidates: Candidate[];
  today: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const act = (fn: () => Promise<{ error: string } | { ok: true }>, then?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if ("error" in result) setError(result.error);
      else {
        setError(null);
        then?.();
      }
    });

  return (
    <div className="space-y-3">
      {candidates.length ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="text-warning">
            The bank seems to have reported this too. Until you decide, only the bank&apos;s counts. Merge them to keep one, with your category,
            tags and shares moved onto the bank&apos;s; or keep both if they&apos;re different purchases.
          </p>
          <ul className="divide-y divide-warning/30">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <Link href={`/transactions/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {c.postedOn} · {c.description}
                </Link>
                <span className="tabular-nums">{formatCents(c.amountCents)}</span>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => mergeManual(txn.id, c.id), () => router.push(`/transactions/${c.id}`))}>
                  Merge into this
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => keepManual(txn.id))}>
            Keep both
          </Button>
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
        <p>
          <span className="font-medium">Added by hand.</span> The bank&apos;s transactions stay as reported; this one you can change or delete.
        </p>
        {editing ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const cents = toCents(String(data.get("amount") ?? ""));
              if (cents === null) return setError("Enter the amount in dollars and cents, like 42.50");
              act(
                () =>
                  updateManual(txn.id, {
                    postedOn: String(data.get("postedOn")),
                    amountCents: txn.amountCents < 0 ? -cents : cents,
                    description: String(data.get("description") ?? ""),
                  }),
                () => setEditing(false),
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {txn.amountCents < 0 ? "Amount out" : "Amount in"}
              <Input name="amount" inputMode="decimal" className="w-28" defaultValue={(Math.abs(txn.amountCents) / 100).toFixed(2)} required />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Date
              <Input name="postedOn" type="date" max={today} defaultValue={txn.postedOn} required />
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Description
              <Input name="description" maxLength={200} defaultValue={txn.description} required />
            </label>
            <Button size="sm" type="submit" disabled={pending}>
              Save
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => deleteManual(txn.id), () => router.push("/transactions"))}>
              Delete
            </Button>
          </div>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
