"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { historyLabel, suggestedTargetCents, type HistorySummary } from "@/lib/budgets/format";
import { formatCents, parseAmountCents } from "@/lib/money";
import { rebalance, removeTarget, setTarget } from "./actions";

// The budget forms. Amounts are typed as dollars and become integer cents
// here; everything else is validated by the operations.

export type TargetChoice = { categoryId: string | null; name: string };

// A yearly bill found by detection (#109), as budgets.yearlyCharges gives it.
export type YearlySuggestion = {
  categoryId: string;
  name: string;
  charges: { merchant: string; latestCents: number; lastOn: string; nextExpectedOn: string }[];
  amountCents: number;
  setAsideMonthlyCents: number;
  anchorMonth: string;
};

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function toCents(text: string): number | null {
  try {
    const cents = parseAmountCents(text.replace(/[$,\s]/g, "") || "x");
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

const select = "h-8 w-full rounded-md border bg-background px-2 text-sm";

const PERIODS = [
  { months: 1, label: "Monthly" },
  { months: 3, label: "Every 3 months" },
  { months: 6, label: "Every 6 months" },
  { months: 12, label: "Annual" },
];

export function TargetForm({
  choices,
  initial,
  histories,
  suggestFrom,
  windowMonths,
  yearly = [],
  onDone,
}: {
  // Categories to pick from when adding; omitted when editing one target.
  choices?: TargetChoice[];
  initial?: TargetChoice & { amountCents: number; periodMonths: number; anchorOn: string; rollover: boolean; sinkingFund: boolean };
  // What each category usually costs (#105), by category id ("" for the buffer).
  histories: Record<string, HistorySummary>;
  // Net history to suggest an amount from (#106): the same as histories,
  // except on the gross view, where suggesting gross would set a target
  // the net budget never reaches.
  suggestFrom: Record<string, HistorySummary>;
  windowMonths: number;
  // Yearly bills in categories without a target yet (adding only).
  yearly?: YearlySuggestion[];
  onDone?: () => void;
}) {
  const [choice, setChoice] = useState<string>(initial ? (initial.categoryId ?? "") : (choices?.[0]?.categoryId ?? ""));
  // Null while adding and untouched: the field then shows the suggestion,
  // following the category and period until the owner types.
  const [amount, setAmount] = useState<string | null>(initial ? (initial.amountCents / 100).toFixed(2) : null);
  const [periodMonths, setPeriodMonths] = useState(initial?.periodMonths ?? 1);
  const [anchorMonth, setAnchorMonth] = useState(initial?.anchorOn.slice(0, 7) ?? "");
  const [rollover, setRollover] = useState(initial?.rollover ?? false);
  const [sinkingFund, setSinkingFund] = useState(initial?.sinkingFund ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // After adding, the chosen category leaves the list; fall back to the
  // first remaining choice rather than keep pointing at the old one (which
  // would quietly overwrite the target just added).
  const selected =
    initial || !choices || choices.some((c) => (c.categoryId ?? "") === choice) ? choice : (choices[0]?.categoryId ?? "");
  const categoryId = selected === "" ? null : selected;
  const name = initial?.name ?? choices?.find((c) => (c.categoryId ?? "") === selected)?.name ?? "";
  // Only a value in the field; nothing is written until the owner saves.
  const suggestion = suggestedTargetCents(suggestFrom[selected], periodMonths);
  const shown = amount ?? (suggestion === null ? "" : String(suggestion / 100));
  const bill = yearly.find((y) => y.categoryId === selected);

  // One tap fills the form as an annual sinking fund whose year ends with
  // the bill's next charge; the owner can still change anything, and
  // nothing is saved until Add target.
  const applyYearly = (y: YearlySuggestion) => {
    setChoice(y.categoryId);
    setAmount((y.amountCents / 100).toFixed(2));
    setPeriodMonths(12);
    setAnchorMonth(y.anchorMonth);
    setSinkingFund(true);
    setError(null);
  };
  const usingBill =
    bill !== undefined && periodMonths === 12 && sinkingFund && anchorMonth === bill.anchorMonth && toCents(shown) === bill.amountCents;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = toCents(shown);
    if (amountCents === null) return setError("Enter an amount like 400 or 1,250.00");
    startTransition(async () => {
      const result = await setTarget(
        { categoryId, amountCents, periodMonths, anchorMonth: periodMonths > 1 && anchorMonth ? anchorMonth : undefined, rollover, sinkingFund: sinkingFund && periodMonths > 1 },
        name,
      );
      if (result?.error) return setError(result.error);
      setError(null);
      // A fresh form after adding: settings carried over from the last
      // target are how one gets rollover it never asked for.
      if (!initial) {
        setAmount(null);
        setPeriodMonths(1);
        setAnchorMonth("");
        setRollover(false);
        setSinkingFund(false);
      }
      onDone?.();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      {choices && yearly.length ? (
        // Where yearly bills were found, so they're found without opening
        // every category.
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Yearly bills found:</span>
          {yearly.map((y) => (
            <button key={y.categoryId} type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => applyYearly(y)}>
              {y.name}
            </button>
          ))}
        </div>
      ) : null}
      {bill ? (
        <div className="space-y-1 rounded-md border border-dashed p-2 text-xs">
          <p>
            {bill.charges.map((c, i) => (
              <span key={c.merchant}>
                {i ? "; " : ""}
                {c.merchant} charges {formatCents(c.latestCents)} a year, last on {day(c.lastOn)}, next around {day(c.nextExpectedOn)}
              </span>
            ))}
            . Setting aside <span className="font-medium tabular-nums">{formatCents(bill.setAsideMonthlyCents)}/month</span> covers it
            without wrecking that month.
          </p>
          {usingBill ? (
            <p className="text-muted-foreground">Filled in as an annual sinking fund. Add the target to keep it.</p>
          ) : (
            <Button type="button" size="xs" variant="outline" onClick={() => applyYearly(bill)}>
              Use as a sinking fund
            </Button>
          )}
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {choices ? (
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">Category</span>
            <select value={selected} onChange={(e) => setChoice(e.target.value)} className={select}>
              {choices.map((c) => (
                <option key={c.categoryId ?? "buffer"} value={c.categoryId ?? ""}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Amount per period</span>
          <Input value={shown} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
          {/* A sense of what it usually costs, so the target isn't a guess. */}
          <span className="block text-xs text-muted-foreground tabular-nums">{historyLabel(histories[selected], windowMonths)}</span>
          {suggestion === null ? null : amount === null ? (
            <span className="block text-xs text-muted-foreground">Filled in from the average. Change it freely.</span>
          ) : toCents(amount) === suggestion ? null : (
            // A way back to the suggestion after typing over it, or when
            // editing a target that has drifted from what the category costs.
            <button
              type="button"
              className="block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground tabular-nums"
              onClick={() => setAmount(initial ? String(suggestion / 100) : null)}
            >
              Use suggested {formatCents(suggestion)}
            </button>
          )}
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Period</span>
          <select value={periodMonths} onChange={(e) => setPeriodMonths(Number(e.target.value))} className={select}>
            {PERIODS.map((p) => (
              <option key={p.months} value={p.months}>
                {p.label}
              </option>
            ))}
            {PERIODS.some((p) => p.months === periodMonths) ? null : <option value={periodMonths}>Every {periodMonths} months</option>}
          </select>
        </label>
        {periodMonths > 1 ? (
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">Periods start in</span>
            {/* Blank means the default: January for annual, this month otherwise. */}
            <Input type="month" value={anchorMonth} onChange={(e) => setAnchorMonth(e.target.value)} />
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          <span>Roll over what&apos;s left (or overspent) into the next period</span>
        </label>
        {periodMonths > 1 ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sinkingFund} onChange={(e) => setSinkingFund(e.target.checked)} />
            <span>Sinking fund: show a monthly set-aside</span>
          </label>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        A change applies from the start of the current period. Earlier periods keep the target they had.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {initial ? "Save" : "Add target"}
        </Button>
        {initial ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            className="text-muted-foreground"
            onClick={() =>
              startTransition(async () => {
                const result = await removeTarget(initial.categoryId, initial.name);
                if (result?.error) return setError(result.error);
                onDone?.();
              })
            }
          >
            Remove target
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

export function RebalanceForm({ targets }: { targets: TargetChoice[] }) {
  const [from, setFrom] = useState(targets[0]?.categoryId ?? "");
  const [to, setTo] = useState(targets[1]?.categoryId ?? "");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nameOf = (id: string) => targets.find((t) => (t.categoryId ?? "") === id)?.name ?? "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = toCents(amount);
    if (amountCents === null) return setError("Enter an amount like 50 or 125.00");
    startTransition(async () => {
      const result = await rebalance(from || null, to || null, amountCents, nameOf(from ?? ""), nameOf(to ?? ""));
      setError(result?.error ?? null);
      if (!result?.error) setAmount("");
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 text-sm">
      <label className="min-w-36 flex-1 space-y-1">
        <span className="block text-xs text-muted-foreground">Move from</span>
        <select value={from ?? ""} onChange={(e) => setFrom(e.target.value)} className={select}>
          {targets.map((t) => (
            <option key={t.categoryId ?? "buffer"} value={t.categoryId ?? ""}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-36 flex-1 space-y-1">
        <span className="block text-xs text-muted-foreground">To</span>
        <select value={to ?? ""} onChange={(e) => setTo(e.target.value)} className={select}>
          {targets.map((t) => (
            <option key={t.categoryId ?? "buffer"} value={t.categoryId ?? ""}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="w-28 space-y-1">
        <span className="block text-xs text-muted-foreground">Amount</span>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending || from === to}>
        Move
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
