"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CategoryOption } from "@/lib/categorize/labels";
import { formatCents, parseAmountCents } from "@/lib/money";
import * as actions from "./actions";

type Txn = {
  id: string;
  amountCents: number;
  categoryId: string | null;
  isSplit: boolean;
  experiencedOn: string | null;
  splits: { amountCents: number; categoryId: string; note: string | null }[];
  tags: { name: string }[];
};

const select = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function useSave() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<actions.ActionResult | null>(null);
  const save = (fn: () => Promise<actions.ActionResult>) => startTransition(async () => setResult(await fn()));
  const feedback =
    result && "error" in result ? <p className="text-sm text-destructive">{result.error}</p> : result ? <p className="text-sm text-muted-foreground">Saved.</p> : null;
  return { pending, save, feedback };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

// Amounts in the split editor are entered as positive dollars; the sign
// comes from the transaction, so a refund splits into positive parts and a
// purchase into negative ones without the owner thinking about it.
type Part = { amount: string; categoryId: string; note: string };

function centsOf(amount: string): number | null {
  try {
    const cents = parseAmountCents(amount.replace(/[$,\s]/g, "") || "x");
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

function SplitEditor({ txn, options }: { txn: Txn; options: CategoryOption[] }) {
  const sign = Math.sign(txn.amountCents) || -1;
  const total = Math.abs(txn.amountCents);
  const initial: Part[] = txn.isSplit
    ? txn.splits.map((s) => ({ amount: (Math.abs(s.amountCents) / 100).toFixed(2), categoryId: s.categoryId, note: s.note ?? "" }))
    : [
        { amount: (total / 100).toFixed(2), categoryId: txn.categoryId ?? "", note: "" },
        { amount: "", categoryId: "", note: "" },
      ];
  const [parts, setParts] = useState<Part[]>(initial);
  const { pending, save, feedback } = useSave();

  const assigned = parts.reduce((sum, p) => sum + (centsOf(p.amount) ?? 0), 0);
  const remaining = total - assigned;
  const valid =
    parts.length >= 2 && remaining === 0 && parts.every((p) => centsOf(p.amount) !== null && p.categoryId);

  const update = (i: number, patch: Partial<Part>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      {parts.map((part, i) => (
        <div key={i} className="grid grid-cols-[6.5rem_1fr_auto] gap-2 sm:grid-cols-[7rem_1fr_1fr_auto]">
          <Input
            inputMode="decimal"
            aria-label={`Part ${i + 1} amount`}
            placeholder="0.00"
            value={part.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
            className="tabular-nums"
          />
          <select aria-label={`Part ${i + 1} category`} className={select} value={part.categoryId} onChange={(e) => update(i, { categoryId: e.target.value })}>
            <option value="">Category…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <Input
            aria-label={`Part ${i + 1} note`}
            placeholder="Note (optional)"
            value={part.note}
            onChange={(e) => update(i, { note: e.target.value })}
            className="col-span-2 sm:col-span-1 sm:row-auto"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove part ${i + 1}`}
            disabled={parts.length <= 2}
            onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
            className="row-start-1 col-start-3 sm:col-start-4"
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={parts.length >= 20}
          onClick={() =>
            setParts((ps) => [...ps, { amount: remaining > 0 ? (remaining / 100).toFixed(2) : "", categoryId: "", note: "" }])
          }
        >
          Add part
        </Button>
        <span className={remaining === 0 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}>
          {remaining === 0
            ? `All ${formatCents(total)} assigned`
            : remaining > 0
              ? `${formatCents(remaining)} left to assign`
              : `${formatCents(-remaining)} over`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!valid || pending}
          onClick={() =>
            save(() =>
              actions.split(
                txn.id,
                parts.map((p) => ({ amountCents: sign * centsOf(p.amount)!, categoryId: p.categoryId, note: p.note.trim() || null })),
              ),
            )
          }
        >
          {txn.isSplit ? "Save split" : "Split"}
        </Button>
        {txn.isSplit ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => save(() => actions.setCategory(txn.id, null))}>
            Remove split
          </Button>
        ) : null}
      </div>
      {feedback}
    </div>
  );
}

export function TransactionEditor({ txn, options, knownTags }: { txn: Txn; options: CategoryOption[]; knownTags: string[] }) {
  const category = useSave();
  const tagSave = useSave();
  const dateSave = useSave();
  const [tagText, setTagText] = useState(txn.tags.map((t) => t.name).join(", "));
  const [experienced, setExperienced] = useState(txn.experiencedOn ?? "");

  const parsedTags = () =>
    tagText
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);

  return (
    <div className="space-y-4">
      <Section title="Category">
        {txn.isSplit ? (
          <p className="text-sm text-muted-foreground">Split across categories below. Choosing one category here replaces the split.</p>
        ) : null}
        <select
          aria-label="Category"
          className={select}
          value={txn.isSplit ? "" : (txn.categoryId ?? "")}
          disabled={category.pending}
          onChange={(e) => category.save(() => actions.setCategory(txn.id, e.target.value || null))}
        >
          <option value="">{txn.isSplit ? "Split" : "Uncategorized"}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {category.feedback}
      </Section>

      <Section title="Split">
        <SplitEditor key={`${txn.isSplit}-${txn.splits.length}-${txn.categoryId}`} txn={txn} options={options} />
      </Section>

      <Section title="Tags">
        <div className="flex gap-2">
          <Input
            list="known-tags"
            aria-label="Tags, comma-separated"
            placeholder="e.g. vacation-2026, tax-deductible"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
          />
          <datalist id="known-tags">
            {knownTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <Button type="button" variant="outline" disabled={tagSave.pending} onClick={() => tagSave.save(() => actions.setTags(txn.id, parsedTags()))}>
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Comma-separated. New tags are created as you save.</p>
        {tagSave.feedback}
      </Section>

      <Section title="Experience date">
        <p className="text-sm text-muted-foreground">
          When this was actually for, if not when it posted — budgets use this date instead. E.g. tickets bought in
          March for a show in July.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input type="date" aria-label="Experience date" value={experienced} onChange={(e) => setExperienced(e.target.value)} className="w-auto" />
          <Button
            type="button"
            variant="outline"
            disabled={dateSave.pending || experienced === (txn.experiencedOn ?? "")}
            onClick={() => dateSave.save(() => actions.setExperienceDate(txn.id, experienced || null))}
          >
            Save
          </Button>
          {txn.experiencedOn ? (
            <Button
              type="button"
              variant="ghost"
              disabled={dateSave.pending}
              onClick={() => {
                setExperienced("");
                dateSave.save(() => actions.setExperienceDate(txn.id, null));
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        {dateSave.feedback}
      </Section>
    </div>
  );
}
