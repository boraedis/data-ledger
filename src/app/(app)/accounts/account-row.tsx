"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { ACCOUNT_KINDS, KIND_LABELS, countsTowardBudgetsByDefault, type AccountKind } from "@/lib/account-kinds";
import { formatCents } from "@/lib/money";
import { updateAccount } from "./actions";
import { ManualValueControls } from "./manual-account";

export type AccountRowData = {
  id: string;
  name: string;
  displayName: string | null;
  kind: AccountKind;
  countsTowardBudgets: boolean;
  balanceCents: number | null;
  currency: string;
  // Kept up by hand (#26): no bank behind it, so it gets value controls
  // instead of a bank name, and no budget flag (nothing posts to it).
  manual: boolean;
  balanceAt: string | null;
};

export function AccountRow({ account }: { account: AccountRowData }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(account.displayName ?? "");

  const save = (patch: Parameters<typeof updateAccount>[1], reason: string) =>
    startTransition(async () => setError((await updateAccount(account.id, patch, reason))?.error ?? null));

  const saveName = () => {
    const next = name.trim() || null;
    if (next === account.displayName) return;
    save({ displayName: next }, next ? `Renamed account to "${next}"` : "Restored the bank's account name");
  };

  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Input
            aria-label="Account name"
            value={name}
            placeholder={account.name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-8 max-w-xs"
          />
          {account.displayName && !account.manual ? (
            <p className="mt-1 text-xs text-muted-foreground">Bank name: {account.name}</p>
          ) : null}
        </div>
        <span className="text-right text-muted-foreground">
          {account.balanceCents === null ? "—" : formatCents(account.balanceCents, account.currency)}
          {account.manual && (account.kind === "loan" || account.kind === "credit") ? " owed" : ""}
          {account.manual ? (
            <span className="block text-xs">
              <ManualBadge /> {account.balanceAt ? `as of ${account.balanceAt.slice(0, 10)}` : ""}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Kind</span>
          <select
            value={account.kind}
            disabled={pending}
            onChange={(e) => {
              const kind = e.target.value as AccountKind;
              save({ kind }, `Changed account kind to ${KIND_LABELS[kind].toLowerCase()}`);
            }}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {account.manual ? null : (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={account.countsTowardBudgets}
            disabled={pending}
            onChange={(e) =>
              save(
                { countsTowardBudgets: e.target.checked },
                e.target.checked ? "Included account in budgets" : "Excluded account from budgets",
              )
            }
          />
          <span>Counts toward budgets</span>
        </label>
        )}
        {!account.manual && account.countsTowardBudgets !== countsTowardBudgetsByDefault(account.kind) ? (
          <span className="text-xs text-muted-foreground">(not the default for this kind)</span>
        ) : null}
      </div>
      {account.manual ? (
        <ManualValueControls
          account={{ id: account.id, name: account.displayName ?? account.name, kind: account.kind, balanceAt: account.balanceAt }}
        />
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

/** The one marker for "entered by hand", used wherever a manual account appears. */
export function ManualBadge() {
  return (
    <span className="rounded border border-dashed px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Manual
    </span>
  );
}
