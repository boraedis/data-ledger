"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { CategoryOption } from "@/lib/categorize/labels";
import { formatCents } from "@/lib/money";
import { GROUP_LABELS, employerKindLabel, kindLabel, type EmployerPayKind, type PayLineGroup, type PayLineKind } from "@/lib/pay/stubs";
import { deleteStub } from "./actions";
import { StubForm, type FormStub } from "./stub-form";

type Stub = Omit<FormStub, "lines"> & {
  id: string;
  deposits: { id: string; postedOn: string; amountCents: number; accountName: string }[];
  totals: Record<PayLineGroup, number>;
  lines: (FormStub["lines"][number] & { group: PayLineGroup; categoryLabel: string | null })[];
};

const GROUPS: PayLineGroup[] = ["tax", "insurance", "retirement", "other"];

// What the employer paid on top: money, so imputed income (a tax value) isn't part of it.
const employerPaid = (stub: { employerLines: { kind: string; amountCents: number }[] }) =>
  stub.employerLines.filter((l) => l.kind !== "imputed_income").reduce((sum, l) => sum + l.amountCents, 0);

function StubCard({ stub, options }: { stub: Stub; options: CategoryOption[] }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (editing) return <StubForm initial={stub} payStubId={stub.id} options={options} onDone={() => setEditing(false)} />;

  return (
    <li className="space-y-2 px-3 py-2 text-sm">
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="min-w-0">
          <span className="block font-medium">
            {stub.payDate} · {stub.employer}
          </span>
          <span className="block text-xs text-muted-foreground">
            {stub.periodStart} to {stub.periodEnd} ·{" "}
            {[
              ...GROUPS.filter((g) => stub.totals[g]).map((g) => `${GROUP_LABELS[g]} ${formatCents(stub.totals[g])}`),
              ...(employerPaid(stub) ? [`Employer paid ${formatCents(employerPaid(stub))}`] : []),
            ].join(" · ")}
          </span>
        </span>
        <span className="shrink-0 text-right tabular-nums">
          {formatCents(stub.grossCents)}
          <span className="block text-xs text-muted-foreground">net {formatCents(stub.netCents)}</span>
        </span>
      </button>
      <p className="text-xs">
        {stub.deposits.length === 1 ? (
          <Link href={`/transactions/${stub.deposits[0].id}`} className="text-muted-foreground underline">
            Linked to its deposit ✓
          </Link>
        ) : stub.deposits.length ? (
          // Pay split across accounts (#91): each part, where it went.
          <span className="text-muted-foreground">
            Linked to {stub.deposits.length} deposits ✓{" "}
            {stub.deposits.map((d, i) => (
              <span key={d.id}>
                {i ? " + " : ""}
                <Link href={`/transactions/${d.id}`} className="underline">
                  {formatCents(d.amountCents)} to {d.accountName}
                </Link>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-warning">Not linked to a deposit yet: budgets count only the deposit until it is.</span>
        )}
      </p>
      {open ? (
        <div className="space-y-2">
          <table className="w-full text-xs">
            <tbody>
                  {stub.lines.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1 pr-2">
                    {l.label}
                    <span className="block text-muted-foreground">{kindLabel(l.kind as PayLineKind)}</span>
                  </td>
                  <td className="py-1 pr-2 text-muted-foreground">{l.categoryLabel ?? "off the gross"}</td>
                  <td className="py-1 text-right tabular-nums">{formatCents(l.amountCents)}</td>
                </tr>
              ))}
              {stub.employerLines.length ? (
                <tr>
                  <td colSpan={3} className="pb-1 pt-3 text-muted-foreground">
                    Paid by your employer, on top:
                  </td>
                </tr>
              ) : null}
              {stub.employerLines.map((l, i) => (
                <tr key={`e${i}`} className="border-t">
                  <td className="py-1 pr-2">
                    {l.label}
                    <span className="block text-muted-foreground">{employerKindLabel(l.kind as EmployerPayKind)}</span>
                  </td>
                  <td className="py-1 pr-2 text-muted-foreground">{l.kind === "imputed_income" ? "taxable, not paid" : "not in gross or net"}</td>
                  <td className="py-1 text-right tabular-nums">{formatCents(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteStub(stub.id, stub.payDate);
                  setError(result?.error ?? null);
                })
              }
            >
              Delete
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function PayStubs({ stubs, next, options }: { stubs: Stub[]; next: FormStub; options: CategoryOption[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Pay stubs</h2>
        {!adding ? <Button onClick={() => setAdding(true)}>Add pay stub</Button> : null}
      </div>
      {adding ? <StubForm initial={next} options={options} onDone={() => setAdding(false)} /> : null}
      {stubs.length ? (
        <ul className="divide-y rounded-lg border">
          {stubs.map((s) => (
            <StubCard key={s.id} stub={s} options={options} />
          ))}
        </ul>
      ) : !adding ? (
        <p className="text-sm text-muted-foreground">No pay stubs yet. Add your latest one; the next starts from it.</p>
      ) : null}
    </section>
  );
}
