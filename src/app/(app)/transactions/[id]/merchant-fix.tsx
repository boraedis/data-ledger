"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setMerchant, unpinMerchant } from "./actions";

// Fixing a transaction's merchant by hand (#291): type or pick a merchant
// (a name no merchant has makes a new one), optionally for the others with
// the same bank description, counted first. The fix is pinned; it can be
// let go, which puts the merchant back to what the name gives.

export function MerchantFix({
  transactionId,
  current,
  pinned,
  merchants,
  similar,
}: {
  transactionId: string;
  current: string | null;
  pinned: boolean;
  merchants: { id: string; name: string }[];
  similar: { transactions: number; alreadyChosen: number };
}) {
  const [name, setName] = useState("");
  const [alsoSimilar, setAlsoSimilar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const listId = useId();
  const typed = name.trim();
  const existing = merchants.find((m) => m.name.toLowerCase() === typed.toLowerCase());
  const act = (fn: () => ReturnType<typeof setMerchant>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) setError(r.error);
      else {
        setError(null);
        setName("");
        router.refresh();
      }
    });

  return (
    <form
      className="space-y-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!typed) return;
        act(() => setMerchant(transactionId, existing ? { merchantId: existing.id } : { name: typed }, alsoSimilar));
      }}
    >
      <label className="block text-xs text-muted-foreground" htmlFor={`${listId}-name`}>
        This is actually…
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${listId}-name`}
          list={listId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={current ?? "Merchant"}
          className="max-w-[16rem]"
          autoComplete="off"
        />
        <datalist id={listId}>
          {merchants.map((m) => (
            <option key={m.id} value={m.name} />
          ))}
        </datalist>
        <Button type="submit" size="sm" variant="outline" disabled={pending || !typed || existing?.name === current}>
          {typed && !existing ? `Make "${typed}"` : "Change merchant"}
        </Button>
        {pinned ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act(() => unpinMerchant(transactionId))}>
            Let it follow the name again
          </Button>
        ) : null}
      </div>
      {similar.transactions ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={alsoSimilar} onChange={(e) => setAlsoSimilar(e.target.checked)} />
          <span>
            Also the {similar.transactions} other transaction{similar.transactions === 1 ? "" : "s"} with exactly this bank description
            {similar.alreadyChosen ? (
              <span className="text-muted-foreground"> ({similar.alreadyChosen} more already have a merchant you chose, and keep it)</span>
            ) : null}
          </span>
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">Chosen by hand, it stays: cleanups and re-linking leave it alone. Undo it in Activity.</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
