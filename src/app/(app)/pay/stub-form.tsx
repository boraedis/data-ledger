"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { CategoryOption } from "@/lib/categorize/labels";
import { formatCents, parseAmountCents } from "@/lib/money";
import { PAY_LINE_KINDS } from "@/lib/pay/stubs";
import { createStub, findDeposits, updateStub, type DepositMatch, type StubFields } from "./actions";

// Adding or editing a pay stub (#60). Pay stubs repeat, so a new one starts
// from the last one: the same deductions and categories, dates moved on by
// one period. Usually only the amounts that changed need typing.
//
// Only amounts and labels: there's nowhere to put an SSN or an address,
// on purpose.

type Line = { kind: string; label: string; amount: string; categoryId: string };
export type FormStub = Omit<StubFields, "lines" | "depositTransactionIds"> & { lines: { kind: string; label: string; amountCents: number; categoryId: string | null }[] };

const input = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm";
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** "$2,450.00 on 2026-06-12", or for pay split across accounts, each part and where it went. */
function matchLabel(match: DepositMatch): string {
  if (match.parts.length === 1) return `${formatCents(match.parts[0].amountCents)} on ${match.parts[0].postedOn}`;
  return `${match.parts.map((p) => `${formatCents(p.amountCents)} to ${p.accountName}`).join(" + ")} (${match.parts[0].postedOn})`;
}

function centsOf(text: string): number | null {
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, "") || "x");
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

export function StubForm({
  initial,
  payStubId,
  options,
  onDone,
}: {
  initial: FormStub;
  payStubId?: string;
  options: CategoryOption[];
  onDone: () => void;
}) {
  const [employer, setEmployer] = useState(initial.employer);
  const [periodStart, setPeriodStart] = useState(initial.periodStart);
  const [periodEnd, setPeriodEnd] = useState(initial.periodEnd);
  const [payDate, setPayDate] = useState(initial.payDate);
  const [gross, setGross] = useState(initial.grossCents ? dollars(initial.grossCents) : "");
  const [net, setNet] = useState(initial.netCents ? dollars(initial.netCents) : "");
  const [lines, setLines] = useState<Line[]>(
    initial.lines.map((l) => ({ kind: l.kind, label: l.label, amount: dollars(l.amountCents), categoryId: l.categoryId ?? "" })),
  );
  const [deposits, setDeposits] = useState<DepositMatch[]>([]);
  const [automatic, setAutomatic] = useState<string[] | null>(null);
  const [deposit, setDeposit] = useState<string>("auto");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const grossCents = centsOf(gross);
  const netCents = centsOf(net);
  const lineCents = lines.map((l) => centsOf(l.amount));
  const withheld = lineCents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const computed = grossCents === null ? null : grossCents - withheld;
  const adds = computed !== null && netCents !== null && computed === netCents && lineCents.every((c) => c !== null && c > 0);

  // Deposits the net could be, once the pay date and net are known.
  useEffect(() => {
    let live = true;
    if (!adds || !netCents) return;
    findDeposits(payDate, netCents, payStubId).then((found) => {
      if (!live) return;
      setDeposits(found.matches);
      setAutomatic(found.automatic);
    });
    return () => {
      live = false;
    };
  }, [adds, payDate, netCents, payStubId]);

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = () =>
    startTransition(async () => {
      const fields: StubFields = {
        employer,
        periodStart,
        periodEnd,
        payDate,
        grossCents: grossCents!,
        netCents: netCents!,
        lines: lines.map((l, i) => ({ kind: l.kind, label: l.label, amountCents: lineCents[i]!, categoryId: l.categoryId || null })),
        ...(deposit === "auto" ? {} : { depositTransactionIds: deposit === "none" ? null : deposit.split(",") }),
      };
      const result = payStubId ? await updateStub(payStubId, fields) : await createStub(fields);
      if (result?.error) setError(result.error);
      else onDone();
    });

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Employer</span>
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} className={`${input} w-full`} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Pay date</span>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className={`${input} w-full`} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Period start</span>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={`${input} w-full`} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Period end</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={`${input} w-full`} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Gross pay</span>
          <input inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="0.00" className={`${input} w-full text-right tabular-nums`} />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Deductions, as on the stub. The category is where each counts in budgets (a transfer category for a 401(k), since it isn&apos;t spending);
          leave it empty to just take it off the gross.
        </p>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap gap-2 rounded-md border border-dashed p-2 sm:flex-nowrap sm:border-0 sm:p-0">
            <select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value })} aria-label="Kind" className={`${input} w-full sm:w-44`}>
              {PAY_LINE_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <input value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} placeholder="Label on the stub" aria-label="Label" className={`${input} min-w-0 flex-1`} />
            <input
              inputMode="decimal"
              value={l.amount}
              onChange={(e) => setLine(i, { amount: e.target.value })}
              placeholder="0.00"
              aria-label="Amount"
              className={`${input} w-24 text-right tabular-nums`}
            />
            <select value={l.categoryId} onChange={(e) => setLine(i, { categoryId: e.target.value })} aria-label="Category" className={`${input} w-full sm:w-44`}>
              <option value="">No category</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove deduction">
              ×
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setLines([...lines, { kind: "federal_income_tax", label: "", amount: "", categoryId: "" }])}
        >
          Add deduction
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Net pay</span>
          <input inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} placeholder="0.00" className={`${input} w-32 text-right tabular-nums`} />
        </label>
        <p className={`pb-2 text-xs ${adds || computed === null || netCents === null ? "text-muted-foreground" : "text-destructive"}`}>
          {computed === null
            ? "Gross less deductions…"
            : `Gross less ${formatCents(withheld)} withheld = ${formatCents(computed)}${netCents !== null && !adds ? `, off by ${formatCents(Math.abs(computed - netCents))}` : adds ? " ✓" : ""}`}
        </p>
      </div>

      {adds ? (
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Deposit of the net pay (split across accounts is fine)</span>
          <select value={deposit} onChange={(e) => setDeposit(e.target.value)} className={`${input} w-full sm:w-auto`}>
            <option value="auto">
              {automatic
                ? `Link automatically: ${matchLabel(deposits.find((d) => d.ids.join(",") === automatic.join(","))!)}`
                : deposits.length
                  ? "Pick one below…"
                  : "None yet: link when it posts"}
            </option>
            {deposits.map((d) => (
              <option key={d.ids.join(",")} value={d.ids.join(",")}>
                {matchLabel(d)}
              </option>
            ))}
            <option value="none">Don&apos;t link</option>
          </select>
        </label>
      ) : null}

      <div className="flex gap-2">
        <Button disabled={!adds || !employer.trim() || pending} onClick={save}>
          {payStubId ? "Save changes" : "Save pay stub"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
