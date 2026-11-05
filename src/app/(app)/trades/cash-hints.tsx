"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import { dismissHint } from "./actions";
import { priceText, type CashRowView } from "./fields";

// Buy and sell cash rows with no draft to attach to (#321): the share change
// may not have synced yet, or the brokerage doesn't report that position.
// Turn one into a trade (quick add, filled in from the row), or say it isn't
// one. Checked again on every sync, so one that finds its draft later
// attaches then.

export function CashHints({ hints, accountName }: { hints: CashRowView[]; accountName: Record<string, string> }) {
  return (
    <ul className="divide-y rounded-lg border">
      {hints.map((h) => (
        <Hint key={h.id} hint={h} accountName={accountName[h.accountId] ?? "An account"} />
      ))}
    </ul>
  );
}

function Hint({ hint: h, accountName }: { hint: CashRowView; accountName: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const params = new URLSearchParams({
    account: h.accountId,
    side: h.side,
    on: h.postedOn,
    cash: h.id,
    ...(h.symbol ? { symbol: h.symbol } : {}),
    ...(h.quantity ? { quantity: h.quantity, price: priceText(h.amountCents, h.quantity) } : {}),
  });
  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0">
          <span className="block truncate">{h.text}</span>
          <span className="block text-xs text-muted-foreground">
            {h.postedOn} · {accountName} · {h.side === "buy" ? "a buy" : "a sale"}
          </span>
        </span>
        <span className="tabular-nums">{formatCents(h.amountCents)}</span>
      </div>
      <p className="flex gap-3 text-xs text-muted-foreground">
        <Link href={`/trades?${params}#add`} className="underline underline-offset-2 hover:text-foreground">
          Make a trade
        </Link>
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          disabled={pending}
          onClick={() => startTransition(async () => setError((await dismissHint(h.id))?.error ?? null))}
        >
          Not a trade
        </button>
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
