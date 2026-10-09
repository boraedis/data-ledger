"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { ACCOUNT_KINDS, countsTowardBudgetsByDefault, type AccountKind } from "@/lib/account-kinds";
import { formatCents } from "@/lib/money";
import { updateAccount } from "./actions";

const KIND_LABELS: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  payment_app: "Payment app",
  brokerage: "Brokerage",
  retirement: "Retirement",
  loan: "Loan",
  other_asset: "Other asset",
};

export type AccountRowData = {
  id: string;
  name: string;
  displayName: string | null;
  kind: AccountKind;
  countsTowardBudgets: boolean;
  balanceCents: number | null;
  currency: string;
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
          {account.displayName ? <p className="mt-1 text-xs text-muted-foreground">Bank name: {account.name}</p> : null}
        </div>
        <span className="text-muted-foreground">
          {account.balanceCents === null ? "—" : formatCents(account.balanceCents, account.currency)}
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
        {account.countsTowardBudgets !== countsTowardBudgetsByDefault(account.kind) ? (
          <span className="text-xs text-muted-foreground">(not the default for this kind)</span>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
