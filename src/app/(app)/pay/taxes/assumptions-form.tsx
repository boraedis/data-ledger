"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { parseAmountCents } from "@/lib/money";
import { saveAssumptions, type AssumptionFields } from "./actions";

// What pay stubs can't tell the estimate (#61). Stored per year, as the
// owner's own data.

const STATUSES: { value: AssumptionFields["filingStatus"]; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "married_joint", label: "Married filing jointly" },
  { value: "married_separate", label: "Married filing separately" },
  { value: "head_of_household", label: "Head of household" },
];

const input = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const dollars = (cents: number) => (cents ? (cents / 100).toFixed(2) : "");
function centsOf(text: string): number | null {
  if (!text.trim()) return 0;
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, ""));
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

export function AssumptionsForm({ initial }: { initial: AssumptionFields }) {
  const [status, setStatus] = useState(initial.filingStatus);
  const [other, setOther] = useState(dollars(initial.otherIncomeCents));
  const [itemize, setItemize] = useState(initial.itemizedDeductionsCents !== null);
  const [itemized, setItemized] = useState(dollars(initial.itemizedDeductionsCents ?? 0));
  const [credits, setCredits] = useState(dollars(initial.creditsCents));
  const [payments, setPayments] = useState(dollars(initial.otherPaymentsCents));
  const [hsaCoverage, setHsaCoverage] = useState(initial.hsaCoverage);
  const [hsaCatchUp, setHsaCatchUp] = useState(initial.hsaCatchUp);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const values = [centsOf(other), itemize ? centsOf(itemized) : 0, centsOf(credits), centsOf(payments)];
  const valid = values.every((v) => v !== null);

  const field = (label: string, value: string, set: (v: string) => void, hint: string) => (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} placeholder="0.00" className={`${input} text-right tabular-nums`} />
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </label>
  );

  return (
    <form
      className="space-y-3 rounded-lg border p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await saveAssumptions({
            year: initial.year,
            filingStatus: status,
            otherIncomeCents: values[0]!,
            itemizedDeductionsCents: itemize ? values[1]! : null,
            creditsCents: values[2]!,
            otherPaymentsCents: values[3]!,
            hsaCoverage,
            hsaCatchUp: hsaCoverage ? hsaCatchUp : false,
          });
          setMessage(result?.error ? { text: result.error, error: true } : { text: "Saved; the estimate above is updated.", error: false });
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Filing status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as AssumptionFields["filingStatus"])} className={input}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {field("Other income for the year", other, setOther, "Interest, side income, a spouse's wages on a joint return")}
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={itemize} onChange={(e) => setItemize(e.target.checked)} />
            Itemize deductions instead of the standard deduction
          </label>
          {itemize ? (
            <input inputMode="decimal" value={itemized} onChange={(e) => setItemized(e.target.value)} placeholder="0.00" aria-label="Itemized deductions" className={`${input} text-right tabular-nums`} />
          ) : null}
        </div>
        {field("Tax credits", credits, setCredits, "Child tax credit and the like, as a yearly total")}
        {field("Federal tax paid outside payroll", payments, setPayments, "Estimated payments, withholding on other income")}
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">HSA coverage</span>
            <select
              value={hsaCoverage ?? ""}
              onChange={(e) => setHsaCoverage(e.target.value === "" ? null : (e.target.value as "self" | "family"))}
              className={input}
            >
              <option value="">No HSA-eligible plan</option>
              <option value="self">Self-only</option>
              <option value="family">Family</option>
            </select>
          </label>
          {hsaCoverage ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={hsaCatchUp} onChange={(e) => setHsaCatchUp(e.target.checked)} />
              55 or older (adds the catch-up)
            </label>
          ) : null}
          <span className="block text-xs text-muted-foreground">Sets the year&apos;s HSA limit, which your and your employer&apos;s contributions share</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!valid || pending}>
          Save assumptions
        </Button>
        {message ? <span className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>{message.text}</span> : null}
      </div>
    </form>
  );
}
