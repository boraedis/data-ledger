"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents, parseAmountCents } from "@/lib/money";
import { addPerson, forgive, setShares, unmatchPayment } from "../../owed/actions";

// Shared expenses (#8) on the transaction page. For money spent: who owes
// what, and the owner's share, which is all that counts in budgets. For money
// received: what it paid back.

type Person = { id: string; name: string };
type Share = { id: string; personId: string; personName: string; amountCents: number; receivedCents: number; forgiven: boolean };
type Cover = { amountCents: number; personName: string; expenseId: string; expenseDate: string; merchant: string };

const select = "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm";

function toCents(text: string): number | null {
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, "") || "x");
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

export function SharePanel({
  transactionId,
  amountCents,
  people: initialPeople,
  shares,
  covers,
}: {
  transactionId: string;
  amountCents: number;
  people: Person[];
  shares: Share[];
  covers: Cover[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState(initialPeople);
  const [rows, setRows] = useState(() => shares.map((s) => ({ personId: s.personId, amount: (s.amountCents / 100).toFixed(2) })));
  const [newName, setNewName] = useState("");

  const act = (fn: () => Promise<{ error: string } | { ok: true; output?: unknown }>, after?: (output: unknown) => void) =>
    startTransition(async () => {
      const result = await fn();
      if ("error" in result) return setError(result.error);
      setError(null);
      after?.(result.output);
    });

  // --- Money received: what it paid back. ---------------------------------
  if (amountCents > 0) {
    if (covers.length === 0) return null;
    return (
      <section className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
        <p className="font-medium">Pays back what friends owed</p>
        <ul className="space-y-1">
          {covers.map((c, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {c.personName} for{" "}
                <Link href={`/transactions/${c.expenseId}`} className="underline">
                  {c.merchant}
                </Link>{" "}
                <span className="text-muted-foreground">({c.expenseDate})</span>
              </span>
              <span className="shrink-0 tabular-nums">{formatCents(c.amountCents)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">The matched part isn&apos;t income, and needs no category.</p>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => unmatchPayment(transactionId))}>
          Unmatch
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>
    );
  }

  // --- Money spent: who owes what. ------------------------------------------
  const gross = -amountCents;
  const owed = shares.filter((s) => !s.forgiven).reduce((sum, s) => sum + s.amountCents, 0) +
    shares.filter((s) => s.forgiven).reduce((sum, s) => sum + s.receivedCents, 0);

  if (!editing) {
    return (
      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-medium">Shared with friends</p>
          {shares.length ? (
            <p className="tabular-nums">
              Your share {formatCents(gross - owed)} <span className="text-muted-foreground">of {formatCents(gross)}</span>
            </p>
          ) : null}
        </div>
        {shares.length ? (
          <ul className="divide-y">
            {shares.map((s) => {
              const left = s.amountCents - s.receivedCents;
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    {s.personName} owes {formatCents(s.amountCents)}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    {s.forgiven
                      ? `forgiven after ${formatCents(s.receivedCents)} paid`
                      : left === 0
                        ? "paid back"
                        : s.receivedCents
                          ? `${formatCents(s.receivedCents)} paid · ${formatCents(left)} left`
                          : "not paid yet"}
                    {!s.forgiven && left > 0 ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => act(() => forgive(s.id, `Forgave ${s.personName}'s remaining ${formatCents(left)}`))}
                      >
                        Forgive
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Paid for others too? Record what each person owes: only your share counts toward budgets, and their payments
            back are matched instead of looking like income.
          </p>
        )}
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          {shares.length ? "Change" : "Split with friends"}
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>
    );
  }

  const parsed = rows.map((r) => ({ personId: r.personId, cents: toCents(r.amount) }));
  const owedNext = parsed.reduce((sum, r) => sum + (r.cents ?? 0), 0);
  const splitEvenly = () => {
    // Everyone listed plus the owner, equal parts; the owner keeps any
    // leftover cent.
    const each = Math.floor(gross / (rows.length + 1));
    setRows(rows.map((r) => ({ ...r, amount: (each / 100).toFixed(2) })));
  };
  const save = () => {
    if (parsed.some((r) => !r.personId || r.cents === null)) return setError("Every row needs a person and an amount");
    const summary = rows.length
      ? `Shared with ${rows.map((r) => people.find((p) => p.id === r.personId)?.name).join(", ")}`
      : "No longer shared";
    act(
      () => setShares(transactionId, parsed.map((r) => ({ personId: r.personId, amountCents: r.cents! })), summary),
      () => setEditing(false),
    );
  };
  const unused = (current: string) => people.filter((p) => p.id === current || !rows.some((r) => r.personId === p.id));

  return (
    <section className="space-y-3 rounded-lg border p-3 text-sm">
      <p className="font-medium">Who owes you what</p>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            aria-label="Person"
            value={row.personId}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, personId: e.target.value } : r)))}
            className={select}
          >
            <option value="">Choose…</option>
            {unused(row.personId).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            aria-label="Amount owed"
            value={row.amount}
            inputMode="decimal"
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
            className="h-8 w-28"
          />
          <Button size="xs" variant="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={unused("").length === 0} onClick={() => setRows([...rows, { personId: unused("")[0]?.id ?? "", amount: "" }])}>
          Add person
        </Button>
        {rows.length ? (
          <Button size="sm" variant="outline" onClick={splitEvenly}>
            Split evenly ({rows.length + 1} ways)
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Someone new" className="h-8 max-w-48" />
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || !newName.trim()}
          onClick={() =>
            act(
              () => addPerson(newName.trim(), []),
              (output) => {
                const person = output as Person;
                setPeople([...people, { id: person.id, name: person.name }]);
                setRows([...rows, { personId: person.id, amount: "" }]);
                setNewName("");
              },
            )
          }
        >
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        Your share: {formatCents(Math.max(0, gross - owedNext))} of {formatCents(gross)}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
