"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { dismissTransfer, pairAsTransfer } from "./actions";

// Pairs that look like a transfer between the owner's own accounts but are
// filed as spending or income (#102), so they count twice: a card payment
// filed as Shopping counts on top of the purchases it pays for. Shown on
// Cash flow and Spending; each pair is settled one way or the other.

type Side = { transactionId: string; postedOn: string; accountName: string; description: string; amountCents: number; categoryName: string | null };

export function MisfiledTransfers({ pairs }: { pairs: { out: Side; in: Side }[] }) {
  if (pairs.length === 0) return null;
  return (
    <details className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" open={pairs.length <= 3}>
      <summary className="cursor-pointer">
        {pairs.length} look{pairs.length === 1 ? "s" : ""} like {pairs.length === 1 ? "a transfer" : "transfers"} between your accounts but{" "}
        {pairs.length === 1 ? "is" : "are"} counted as spending or income
      </summary>
      <p className="mt-1 text-xs">
        The same amount left one of your accounts and arrived in another within 5 days, but it&apos;s filed under a category, so it counts. A card
        payment filed this way counts on top of the purchases it paid for.
      </p>
      <ul className="mt-2 divide-y divide-warning/30 text-foreground">
        {pairs.map((p) => (
          <Pair key={p.out.transactionId} pair={p} />
        ))}
      </ul>
    </details>
  );
}

function Pair({ pair }: { pair: { out: Side; in: Side } }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: typeof pairAsTransfer) =>
    startTransition(async () => {
      const result = await fn(pair.out.transactionId, pair.in.transactionId);
      setError("error" in result ? result.error : null);
    });
  const side = (s: Side, dir: string) => (
    <Link href={`/transactions/${s.transactionId}`} className="flex justify-between gap-3 hover:underline">
      <span className="min-w-0 truncate">
        {dir} {s.accountName} · {s.postedOn} · {s.description}
        <span className="text-muted-foreground"> · {s.categoryName ?? "uncategorized"}</span>
      </span>
      <span className="shrink-0 tabular-nums">{formatCents(s.amountCents)}</span>
    </Link>
  );
  return (
    <li className="space-y-1 py-2">
      {side(pair.out, "Out of")}
      {side(pair.in, "Into")}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(pairAsTransfer)}>
          Pair as transfer
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(dismissTransfer)}>
          Not a transfer
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}
