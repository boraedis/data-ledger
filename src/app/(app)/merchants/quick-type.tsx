"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setMerchantType } from "./actions";

// Filling in types from the list: shown on each row while it's filtered to
// merchants with no type yet. Picking one sets it right away (one undoable
// change each, in Activity), and the row leaves the list.

export function QuickType({ merchantId, name, types }: { merchantId: string; name: string; types: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <select
        aria-label={`Type for ${name}`}
        defaultValue=""
        disabled={pending}
        onChange={(e) => {
          const typeId = e.target.value;
          if (!typeId) return;
          start(async () => {
            const r = await setMerchantType(merchantId, typeId);
            if ("error" in r) setError(r.error);
            else router.refresh();
          });
        }}
        className="h-8 rounded border bg-background px-2 text-xs text-foreground"
      >
        <option value="">{pending ? "Saving…" : "Set type…"}</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
