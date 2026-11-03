"use client";

import { useState, useTransition } from "react";
import { setPromotion } from "./tally-actions";

// Which of Tally's changes apply without asking (#59). Every one is off
// until turned on here, and only routine, undoable changes are listed: the
// rest always come to the owner as proposals.
export function TallyPromotions({ promotions }: { promotions: { operation: string; label: string; promoted: boolean }[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tally proposes changes and you approve them. For the routine ones below, you can let Tally go ahead without asking. Each is
        still logged in Activity, marked auto-applied, and can be undone there. Anything not listed always asks first.
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {promotions.map((p) => (
          <li key={p.operation} className="flex items-center justify-between gap-3 px-3 py-2">
            <label htmlFor={`promote-${p.operation}`} className="min-w-0">
              {p.label}
              <span className="block font-mono text-xs text-muted-foreground">{p.operation}</span>
            </label>
            <input
              id={`promote-${p.operation}`}
              type="checkbox"
              role="switch"
              checked={p.promoted}
              disabled={pending}
              aria-describedby={`promote-${p.operation}-state`}
              onChange={(e) => {
                const next = e.target.checked;
                startTransition(async () => setError((await setPromotion(p.operation, p.label, next))?.error ?? null));
              }}
              className="size-4"
            />
            <span id={`promote-${p.operation}-state`} className="sr-only">
              {p.promoted ? "Applies without asking" : "Asks first"}
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
