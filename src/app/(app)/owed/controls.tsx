"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/money";
import { addPerson, confirmMatch, dismissPayment, forgive, updatePerson } from "./actions";

type Result = { error: string } | { ok: true; output?: unknown };

function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<Result>, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if ("error" in result) return setError(result.error);
      setError(null);
      after?.();
    });
  return { pending, error, act };
}

const KIND_LABEL = {
  exact: "Exact match",
  combined: "Covers several",
  partial: "Partial payment",
  more: "More than owed",
} as const;

export function ProposalActions({
  transactionId,
  personName,
  kind,
  allocations,
}: {
  transactionId: string;
  personName: string;
  kind: keyof typeof KIND_LABEL;
  allocations: { reimbursementId: string; amountCents: number }[];
}) {
  const { pending, error, act } = useAction();
  const total = allocations.reduce((s, a) => s + a.amountCents, 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded border px-1.5 text-xs text-muted-foreground">{KIND_LABEL[kind]}</span>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => act(() => confirmMatch(transactionId, allocations, `Matched ${formatCents(total)} from ${personName}`))}
      >
        Confirm
      </Button>
      <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => act(() => dismissPayment(transactionId))}>
        Not a reimbursement
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function ForgiveButton({ reimbursementId, summary }: { reimbursementId: string; summary: string }) {
  const { pending, error, act } = useAction();
  return (
    <>
      <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => act(() => forgive(reimbursementId, summary))}>
        Forgive
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </>
  );
}

const splitAliases = (text: string) =>
  text
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

export function PersonRow({ person }: { person: { id: string; name: string; aliases: string[] } }) {
  const { pending, error, act } = useAction();
  const [name, setName] = useState(person.name);
  const [aliases, setAliases] = useState(person.aliases.join(", "));
  const changed = name.trim() !== person.name || splitAliases(aliases).join("|") !== person.aliases.join("|");
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-40" />
      <Input
        aria-label="Other spellings"
        value={aliases}
        onChange={(e) => setAliases(e.target.value)}
        placeholder="Other spellings, comma-separated"
        className="h-8 min-w-48 flex-1"
      />
      {changed ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => updatePerson(person.id, name.trim(), splitAliases(aliases)))}>
          Save
        </Button>
      ) : null}
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function AddPerson() {
  const { pending, error, act } = useAction();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          () => addPerson(name.trim(), splitAliases(aliases)),
          () => {
            setName("");
            setAliases("");
          },
        );
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-8 w-40" />
      <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Other spellings (optional)" className="h-8 min-w-48 flex-1" />
      <Button type="submit" size="sm" disabled={pending || !name.trim()}>
        Add person
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
