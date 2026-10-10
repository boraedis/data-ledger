"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACCOUNT_KINDS, KIND_LABELS, type AccountKind } from "@/lib/account-kinds";
import { parseAmountCents } from "@/lib/money";
import { createManualAccount, deleteManualAccount, setManualValue } from "./actions";

// Manual accounts (#26): things no bank sync covers. Values are entered as
// positive amounts; for a loan or credit kind that's the amount owed, and
// net worth counts it as a debt.

const LIABILITY: AccountKind[] = ["credit", "loan"];

/** Today in the owner's own time zone, which is what "as of today" means to them. */
function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** "$1,234.50" or "1234.5" → cents; null if it isn't a non-negative amount. */
function parseValue(text: string): number | null {
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, "") || "x");
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

function valueLabel(kind: AccountKind) {
  return LIABILITY.includes(kind) ? "Amount owed" : "Value";
}

export function AddManualAccount() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("other_asset");
  const [value, setValue] = useState("");
  const [on, setOn] = useState(localToday);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a manual account
      </Button>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const valueCents = parseValue(value);
    if (!name.trim()) return setError("Give it a name");
    if (valueCents === null) return setError(`${valueLabel(kind)} should be an amount like 12500 or 12,500.00`);
    startTransition(async () => {
      const result = await createManualAccount({ name: name.trim(), kind, valueCents, on });
      if (result?.error) return setError(result.error);
      // A fresh form each time: carrying the last kind over is how a car
      // ends up filed as a loan.
      setOpen(false);
      setName("");
      setKind("other_asset");
      setValue("");
      setOn(localToday());
      setError(null);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground">
        For things no bank connection covers: a home, a car, a loan from a friend, an account at an unsupported
        institution. You update its value by hand, and each update becomes part of its net-worth history.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hatchback" maxLength={60} />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AccountKind)}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          >
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{valueLabel(kind)}</span>
          <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">As of</span>
          <Input type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} />
        </label>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ManualValueControls({
  account,
}: {
  account: { id: string; name: string; kind: AccountKind; balanceAt: string | null };
}) {
  const [value, setValue] = useState("");
  const [on, setOn] = useState(localToday);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const valueCents = parseValue(value);
    if (valueCents === null) return setError(`${valueLabel(account.kind)} should be an amount like 12500 or 12,500.00`);
    startTransition(async () => {
      const result = await setManualValue(account.id, account.name, valueCents, on);
      setError(result?.error ?? null);
      if (!result?.error) setValue("");
    });
  };

  const remove = () => {
    if (!confirm(`Remove "${account.name}" and its value history? You can undo this from Activity.`)) return;
    startTransition(async () => setError((await deleteManualAccount(account.id, account.name))?.error ?? null));
  };

  return (
    <div className="space-y-1">
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`New ${valueLabel(account.kind).toLowerCase()}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          placeholder={`New ${valueLabel(account.kind).toLowerCase()}`}
          className="h-8 w-36"
          disabled={pending}
        />
        <Input
          aria-label="As of"
          type="date"
          value={on}
          max={localToday()}
          onChange={(e) => setOn(e.target.value)}
          className="h-8 w-40"
          disabled={pending}
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !value}>
          Update value
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={pending} className="text-muted-foreground">
          Remove
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
