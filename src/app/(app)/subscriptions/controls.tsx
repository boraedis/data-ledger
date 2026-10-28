"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cancelSubscription, checkNow, dismissAlert, setStatus } from "./actions";

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

// "Cancelled…" opens a date (today unless changed): the day the
// subscription was cancelled, after which a charge raises an alert.
export function CancelButton({ merchant, accountId, today }: { merchant: string; accountId: string; today: string }) {
  const { pending, error, act } = useAction();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today);
  if (!open) {
    return (
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
        Cancelled…
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        act(() => cancelSubscription(merchant, accountId, on));
      }}
    >
      <label className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
        Cancelled on
        <input type="date" required max={today} value={on} onChange={(e) => setOn(e.target.value)} className="rounded border bg-background px-1 py-0.5 text-xs" />
      </label>
      <Button type="submit" size="xs" disabled={pending}>
        Mark cancelled
      </Button>
      <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => setOpen(false)}>
        Back
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </form>
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
