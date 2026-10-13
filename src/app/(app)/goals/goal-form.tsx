"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseAmountCents } from "@/lib/money";
import { archiveGoal, createGoal, updateGoal } from "./actions";

// Add or edit a savings goal. Progress needs a source: linked accounts
// (their balance counts), a tag (transfers with it count), or both.

export type AccountChoice = { id: string; name: string; kindLabel: string };

function toCents(text: string): number | null {
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, "") || "x");
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

export function GoalForm({
  accounts,
  initial,
  onDone,
}: {
  accounts: AccountChoice[];
  initial?: { id: string; name: string; targetCents: number; targetDate: string | null; accountIds: string[]; tagName: string | null };
  onDone?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [target, setTarget] = useState(initial ? (initial.targetCents / 100).toFixed(2) : "");
  const [date, setDate] = useState(initial?.targetDate ?? "");
  const [linked, setLinked] = useState<string[]>(initial?.accountIds ?? []);
  const [tag, setTag] = useState(initial?.tagName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const targetCents = toCents(target);
    if (!name.trim()) return setError("Give it a name");
    if (targetCents === null) return setError("Enter a target like 5000 or 12,500.00");
    const fields = { name: name.trim(), targetCents, targetDate: date || null, accountIds: linked, tagName: tag.trim().replace(/^#/, "") || null };
    startTransition(async () => {
      const result = initial ? await updateGoal(initial.id, fields) : await createGoal(fields);
      if (result?.error) return setError(result.error);
      setError(null);
      if (!initial) {
        setName("");
        setTarget("");
        setDate("");
        setLinked([]);
        setTag("");
      }
      onDone?.();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emergency fund" maxLength={60} />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Target</span>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">By (optional)</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs text-muted-foreground">Count these accounts&apos; balances</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={linked.includes(a.id)}
                onChange={(e) => setLinked(e.target.checked ? [...linked, a.id] : linked.filter((id) => id !== a.id))}
              />
              <span>
                {a.name} <span className="text-muted-foreground">({a.kindLabel})</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block max-w-sm space-y-1">
        <span className="block text-xs text-muted-foreground">And/or transfers tagged</span>
        <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="#trip-fund" />
        <span className="block text-xs text-muted-foreground">
          Tag the transfer out of your everyday account; it counts toward the goal. Money moved back counts against it.
        </span>
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {initial ? "Save" : "Add goal"}
        </Button>
        {initial ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await archiveGoal(initial.id, initial.name, true);
                if (result?.error) return setError(result.error);
                onDone?.();
              })
            }
          >
            Archive
          </Button>
        ) : null}
        {onDone ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function GoalEditor(props: { accounts: AccountChoice[]; initial: NonNullable<Parameters<typeof GoalForm>[0]["initial"]> }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="border-t pt-3">
      <GoalForm {...props} onDone={() => setOpen(false)} />
    </div>
  ) : (
    <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
      Edit goal
    </Button>
  );
}

export function RestoreGoal({ goalId, name }: { goalId: string; name: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={() => startTransition(async () => void (await archiveGoal(goalId, name, false)))}>
      Restore
    </Button>
  );
}
