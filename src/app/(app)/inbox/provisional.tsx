"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { discardAlert, matchAlert } from "./actions";

// Purchase alerts waiting for the bank (#30). Most are matched by the
// nightly pipeline without anyone looking; what's left here after a week
// is either a charge that never went through or one the bank reported
// with a different amount (a tip), and only the owner can say which.

export type ProvisionalRow = {
  id: string;
  accountName: string;
  postedOn: string;
  amountCents: number;
  merchant: string | null;
  description: string;
  source: "email" | "apple_pay";
  counting: boolean;
  stale: boolean;
  candidates: { id: string; postedOn: string; amountCents: number; merchant: string | null; description: string }[];
};

const SOURCE = { email: "email alert", apple_pay: "Apple Pay" } as const;

function Row({ row }: { row: ProvisionalRow }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ error: string } | { ok: true }>) =>
    startTransition(async () => {
      const result = await fn();
      setError("error" in result ? result.error : null);
    });

  return (
    <li className={`space-y-2 px-3 py-2 text-sm ${row.stale ? "bg-amber-500/10" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/transactions/${row.id}`} className="min-w-0 flex-1 hover:underline">
          <span className="block truncate font-medium">{row.merchant ?? row.description}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.postedOn} · {row.accountName} · {SOURCE[row.source]}
            {row.counting ? " · counts toward budgets for now" : ""}
          </span>
        </Link>
        <span className="shrink-0 tabular-nums">{formatCents(row.amountCents)}</span>
      </div>
      {row.stale ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            The bank hasn&apos;t reported this amount in a week. If it charged a different amount (a tip, say), pick it; if the charge never
            went through, discard the alert.
          </p>
          <div className="flex flex-wrap gap-2">
            {row.candidates.map((c) => (
              <Button key={c.id} size="sm" variant="outline" disabled={pending} onClick={() => act(() => matchAlert(row.id, c.id))}>
                It was {formatCents(Math.abs(c.amountCents))} on {c.postedOn}
                {c.merchant ? ` · ${c.merchant}` : ""}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => act(() => discardAlert(row.id))}>
              Never charged — discard
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function ProvisionalList({ rows }: { rows: ProvisionalRow[] }) {
  return (
    <section id="alerts" className="space-y-2">
      <h2 className="text-lg font-semibold">Waiting for the bank</h2>
      <p className="text-sm text-muted-foreground">
        Purchases from alerts, before the bank reports them. When it does, they&apos;re matched and anything you set carries over.
      </p>
      <ul className="divide-y rounded-lg border">
        {rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}
