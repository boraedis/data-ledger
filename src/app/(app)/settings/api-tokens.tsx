"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createToken, revokeToken } from "./token-actions";

type TokenRow = { id: string; label: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function ApiTokens({ tokens }: { tokens: TokenRow[] }) {
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createToken(label);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      setCreated(result.token);
      setLabel("");
    });
  }

  return (
    <div className="space-y-3">
      {created ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Copy this token now — it won&apos;t be shown again.</p>
          <code className="block break-all rounded bg-background px-2 py-1 font-mono text-xs">{created}</code>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(created)}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {tokens.length ? (
        <ul className="divide-y rounded-lg border">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className={t.revokedAt ? "text-muted-foreground line-through" : undefined}>
                <span>{t.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t.revokedAt
                    ? `revoked ${when.format(t.revokedAt)}`
                    : t.lastUsedAt
                      ? `last used ${when.format(t.lastUsedAt)}`
                      : `created ${when.format(t.createdAt)}, never used`}
                </span>
              </div>
              {t.revokedAt ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => startTransition(() => revokeToken(t.id))}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          placeholder="Name, e.g. Claude Code on laptop"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={pending || !label.trim()}>
          Create token
        </Button>
      </form>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
