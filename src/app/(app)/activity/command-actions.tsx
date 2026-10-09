"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approve, reject, undo } from "./actions";

export function CommandActions({ commandId, status, isUndo }: { commandId: string; status: string; isUndo: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const act = (action: (id: string) => Promise<{ error: string } | undefined>) =>
    startTransition(async () => {
      setError((await action(commandId))?.error ?? null);
    });

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {status === "proposed" ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => act(approve)}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(reject)}>
              Reject
            </Button>
          </>
        ) : null}
        {status === "applied" && !isUndo ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(undo)}>
            Undo
          </Button>
        ) : null}
      </div>
      {error ? <p className="max-w-xs text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
