"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { checkNow, dismissAlert, setStatus } from "./actions";

function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ error: string } | undefined>) => startTransition(async () => setError((await fn())?.error ?? null));
  return { pending, error, act };
}

export function StatusButtons({
  merchant,
  accountId,
  options,
}: {
  merchant: string;
  accountId: string;
  options: { label: string; status: "confirmed" | "dismissed" | null; primary?: boolean }[];
}) {
  const { pending, error, act } = useAction();
  return (
    <span className="flex flex-wrap items-center gap-1">
      {options.map((o) => (
        <Button
          key={o.label}
          size="xs"
          variant={o.primary ? "default" : "ghost"}
          className={o.primary ? "" : "text-muted-foreground"}
          disabled={pending}
          onClick={() => act(() => setStatus(merchant, accountId, o.status))}
        >
          {o.label}
        </Button>
      ))}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

export function DismissAlert({ alertId, title }: { alertId: string; title: string }) {
  const { pending, error, act } = useAction();
  return (
    <>
      <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => act(() => dismissAlert(alertId, title))}>
        Dismiss
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </>
  );
}

export function CheckNow() {
  const { pending, error, act } = useAction();
  return (
    <>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act(checkNow)}>
        {pending ? "Checking…" : "Check now"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </>
  );
}
