"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { pairWithExisting } from "./actions";
import { privateName } from "@/lib/privacy/names";

const select = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm";

// On an unpaired transfer (#252): rows that already exist and could be its
// other half. This is the way back from "Not a transfer", which stops the
// matcher pairing either side again, and the fix for a wrong match: unpair,
// then pair with the right row.
export function PairWithExisting({
  transactionId,
  amountCents,
  candidates,
}: {
  transactionId: string;
  amountCents: number;
  candidates: { id: string; postedOn: string; accountName: string; description: string; categoryName: string | null }[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const otherId = String(new FormData(e.currentTarget).get("otherId"));
        startTransition(async () => {
          const result = await pairWithExisting(transactionId, otherId, amountCents);
          setError("error" in result ? result.error : null);
        });
      }}
    >
      <p>
        {candidates.length === 1 ? "A transaction" : "Transactions"} in another of your accounts {amountCents > 0 ? "left" : "arrived"} for this exact amount within 5
        days. Pairing makes them one transfer; neither counts as spending or income. This also works for rows marked &quot;Not a transfer&quot;.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Pair with
          <select name="otherId" className={select} required defaultValue={candidates[0]?.id}>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.postedOn} · {privateName("account", c.accountName)} · {privateName("description", c.description)}
                {c.categoryName ? ` (filed as ${c.categoryName})` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" type="submit" disabled={pending}>
          Pair
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
