"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { reviewFlag } from "./actions";

// Charges the suspicious-transaction checks flagged (#33), waiting for the
// owner to say whether each is theirs. "Fine" teaches the checks; the rule
// for how is in src/lib/suspicious/checks.ts and in each line below.

export type FlagRow = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  transactionId: string | null;
  amountCents: number | null;
};

const KIND_LABEL: Record<string, string> = {
  unusual_amount: "Unusually large",
  new_merchant: "New merchant",
  possible_duplicate: "Possible duplicate",
  foreign_fee: "Foreign fee",
};

// What "Fine" will change, so the owner knows the answer matters.
const FINE_TEACHES: Record<string, string> = {
  unusual_amount: "Fine raises the bar for this merchant to this amount.",
  new_merchant: "Fine sets this as a normal amount here. After three first-time charges marked fine, the bar for new merchants rises.",
  possible_duplicate: "Fine stops duplicate checks for this merchant.",
  foreign_fee: "",
};

function Row({ flag }: { flag: FlagRow }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const answer = (verdict: "fine" | "suspicious") =>
    startTransition(async () => {
      const result = await reviewFlag(flag.id, verdict, flag.title);
      setError("error" in result ? result.error : null);
    });

  return (
    <li className="space-y-2 px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="mr-2 rounded bg-warning/15 px-1.5 text-xs text-warning">{KIND_LABEL[flag.kind] ?? flag.kind}</span>
        {flag.transactionId ? (
          <Link href={`/transactions/${flag.transactionId}`} className="font-medium underline-offset-2 hover:underline">
            {flag.title}
          </Link>
        ) : (
          <span className="font-medium">{flag.title}</span>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">{flag.detail}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => answer("fine")}>
          Fine, it&apos;s mine
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => answer("suspicious")}>
          Suspicious
        </Button>
        {FINE_TEACHES[flag.kind] ? <span className="text-xs text-muted-foreground">{FINE_TEACHES[flag.kind]}</span> : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function FlagList({ open, suspicious }: { open: FlagRow[]; suspicious: FlagRow[] }) {
  return (
    <section id="flags" className="space-y-2">
      <h2 className="text-lg font-semibold">Check these</h2>
      <p className="text-sm text-muted-foreground">Charges that look out of the ordinary. Say whether each is yours; the checks learn from it.</p>
      {open.length ? (
        <ul className="divide-y rounded-lg border border-warning/40 bg-warning/5">
          {open.map((f) => (
            <Row key={f.id} flag={f} />
          ))}
        </ul>
      ) : null}
      {suspicious.length ? (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Marked suspicious in the last 30 days. Dispute these with the card issuer; the app can&apos;t do that for you.
          </p>
          <ul className="space-y-1 text-sm">
            {suspicious.map((f) => (
              <li key={f.id} className="flex justify-between gap-3">
                {f.transactionId ? (
                  <Link href={`/transactions/${f.transactionId}`} className="min-w-0 truncate hover:underline">
                    {f.title}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate">{f.title}</span>
                )}
                {f.amountCents !== null ? <span className="shrink-0 tabular-nums">{formatCents(f.amountCents)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
