"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { dismissCard, mapCard, newToken, revoke } from "./shortcut-actions";

// Apple Pay purchase alerts (#32): the tokens the iOS Shortcut sends, and
// which Wallet card is which account. Setup is in docs/apple-pay-shortcut.md.

type Token = { id: string; label: string; created: string; lastUsed: string | null };
type Account = { id: string; name: string; walletCardName: string | null };
type Unmapped = { name: string; lastSeen: string };

const input = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm";

export function ApplePay({ endpoint, tokens, accounts, unmapped }: { endpoint: string; tokens: Token[]; accounts: Account[]; unmapped: Unmapped[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [label, setLabel] = useState("iPhone");
  const [cardName, setCardName] = useState("");
  const [cardAccount, setCardAccount] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});

  const run = (fn: () => Promise<{ error: string } | { ok: true }>, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      setError("error" in result ? result.error : null);
      if (!("error" in result)) after?.();
    });

  const mapped = accounts.filter((a) => a.walletCardName);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        An iOS Shortcut sends each Apple Pay purchase here the moment you pay, so it shows up (and notifies you) before the bank reports it.
        Setup: <a className="underline" href="https://github.com/boraedis/data-ledger/blob/main/docs/apple-pay-shortcut.md" target="_blank" rel="noreferrer">
          docs/apple-pay-shortcut.md
        </a>.
      </p>

      <div className="space-y-2">
        <h3 className="font-medium">Shortcut tokens</h3>
        {issued ? (
          <div className="space-y-1 rounded-lg border border-dashed p-3">
            <p>Copy this into the Shortcut now. It won&apos;t be shown again.</p>
            <code className="block break-all rounded bg-secondary px-2 py-1 text-xs">{issued}</code>
            <p className="text-xs text-muted-foreground">
              It posts to <code className="break-all">{endpoint}</code> with the header <code>Authorization: Bearer</code> and the token.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        ) : null}
        {tokens.length ? (
          <ul className="divide-y rounded-lg border">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {t.label}
                  <span className="block text-xs text-muted-foreground">{t.lastUsed ? `Last used ${t.lastUsed}` : `Created ${t.created}, not used yet`}</span>
                </span>
                <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => run(() => revoke(t.id))}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await newToken(label);
              if ("error" in result) setError(result.error);
              else {
                setError(null);
                setIssued(result.token);
              }
            });
          }}
        >
          <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Device name" className={`${input} w-40`} />
          <Button size="sm" type="submit" variant="outline" disabled={pending || !label.trim()}>
            Create token
          </Button>
        </form>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Wallet cards</h3>
        <p className="text-xs text-muted-foreground">An Apple Pay alert only names the card, as it appears in Wallet. Tell it which account that is.</p>
        {unmapped.length ? (
          <ul className="divide-y rounded-lg border border-warning/40 bg-warning/5">
            {unmapped.map((u) => (
              <li key={u.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  “{u.name}” <span className="text-xs text-muted-foreground">· last seen {u.lastSeen}, not mapped</span>
                </span>
                <select
                  aria-label={`Account for ${u.name}`}
                  className={input}
                  value={choice[u.name] ?? ""}
                  onChange={(e) => setChoice({ ...choice, [u.name]: e.target.value })}
                >
                  <option value="">Account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={pending || !choice[u.name]} onClick={() => run(() => mapCard(choice[u.name], u.name))}>
                  Map
                </Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => run(() => dismissCard(u.name))}>
                  Ignore
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {mapped.length ? (
          <ul className="divide-y rounded-lg border">
            {mapped.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  “{a.walletCardName}” <span className="text-muted-foreground">→ {a.name}</span>
                </span>
                <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => run(() => mapCard(a.id, null))}>
                  Unmap
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => mapCard(cardAccount, cardName.trim()),
              () => {
                setCardName("");
                setCardAccount("");
              },
            );
          }}
        >
          <input
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
            placeholder="Card name in Wallet"
            aria-label="Card name in Wallet"
            className={`${input} w-48`}
          />
          <select aria-label="Account" className={input} value={cardAccount} onChange={(e) => setCardAccount(e.target.value)}>
            <option value="">Account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" variant="outline" disabled={pending || !cardName.trim() || !cardAccount}>
            Add card
          </Button>
        </form>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
