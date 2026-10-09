"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents } from "@/lib/money";
import type { ConnectionHealth } from "@/lib/sync/health";
import { addConnection, syncNow } from "./connection-actions";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function Feedback({ result }: { result: { error: string } | { ok: true; message?: string } | null }) {
  if (!result) return null;
  if ("error" in result) return <p className="text-sm text-destructive">{result.error}</p>;
  return result.message ? <p className="text-sm text-muted-foreground">{result.message}</p> : null;
}

function ConnectionCard({ connection }: { connection: ConnectionHealth }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof syncNow>> | null>(null);

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {connection.label}{" "}
            {connection.status === "broken" ? (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">broken</span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {connection.lastSuccessAt ? `Last synced ${when.format(connection.lastSuccessAt)}` : "Never synced"}
          </p>
          {connection.lastError ? <p className="text-xs text-destructive">{connection.lastError}</p> : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(async () => setResult(await syncNow(connection.id)))}
        >
          {pending ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      <Feedback result={result} />
      {connection.messages.map((m, i) => (
        <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
          {m.message}
        </p>
      ))}
      {connection.institutions.map((inst) => (
        <div key={inst.institutionId} className="space-y-1 border-t pt-2">
          <p className="flex items-center gap-2 font-medium">
            {inst.institution}
            {inst.messages.length || inst.stale ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                needs attention
              </span>
            ) : null}
          </p>
          {inst.messages.map((m, i) => (
            <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
              {m.message}
            </p>
          ))}
          <ul className="space-y-0.5">
            {inst.accounts.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 text-xs">
                <span>{a.name}</span>
                <span className="text-muted-foreground">
                  {a.balanceCents === null ? "—" : formatCents(a.balanceCents)}
                  {a.balanceAt ? ` · ${when.format(a.balanceAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Connections({ health }: { health: ConnectionHealth[] }) {
  const [label, setLabel] = useState("SimpleFIN");
  const [setupToken, setSetupToken] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof addConnection>> | null>(null);

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const outcome = await addConnection(label, setupToken);
      setResult(outcome);
      if ("ok" in outcome) setSetupToken("");
    });
  }

  return (
    <div className="space-y-3">
      {health.map((c) => (
        <ConnectionCard key={c.id} connection={c} />
      ))}
      <form onSubmit={handleAdd} className="space-y-2 rounded-lg border border-dashed p-3">
        <p className="text-sm font-medium">Connect SimpleFIN Bridge</p>
        <div className="space-y-1">
          <Label htmlFor="sf-label">Name</Label>
          <Input id="sf-label" value={label} onChange={(e) => setLabel(e.target.value)} className="max-w-xs" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sf-token">Setup token</Label>
          {/* A password field so the token isn't left visible on screen; it
              works once, and the server never shows it back. */}
          <Input
            id="sf-token"
            type="password"
            autoComplete="off"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            From SimpleFIN Bridge → your app connection → &quot;Setup Token&quot;. It can only be used once.
          </p>
        </div>
        <Button type="submit" variant="outline" disabled={pending || !setupToken.trim()}>
          {pending ? "Connecting and syncing…" : "Connect"}
        </Button>
        <Feedback result={result} />
      </form>
    </div>
  );
}
