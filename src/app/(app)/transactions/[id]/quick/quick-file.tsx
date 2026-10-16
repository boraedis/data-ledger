"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { filterOptions, type CategoryOption } from "@/lib/categorize/labels";
import { formatCents, parseAmountCents } from "@/lib/money";
import { fileAs, splitInto, undo, type QuickResult } from "./actions";

// The quick-file screen (#34). Built for a phone held in one hand, seconds
// after paying: the likely categories as big buttons, anything else a
// search away, a split for a mixed basket, and Undo right where you tapped.

type Txn = {
  id: string;
  merchant: string;
  amountCents: number;
  postedOn: string;
  accountName: string;
  provisional: "email" | "apple_pay" | null;
  current: string | null;
};
type Choice = { categoryId: string; label: string; source: "rule" | "memory" | "model" | "recent" };

const SOURCE: Record<Choice["source"], string> = {
  rule: "your rule",
  memory: "you usually",
  model: "model's guess",
  recent: "recent",
};

const big = "h-12 w-full justify-between px-4 text-base";

function centsOf(amount: string): number | null {
  try {
    const cents = parseAmountCents(amount.replace(/[$,\s]/g, "") || "x");
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

/** Itemize a mixed basket: each part's amount, and the last part takes whatever's left. */
function Split({ txn, options, onSaved }: { txn: Txn; options: CategoryOption[]; onSaved: (result: QuickResult, label: string) => void }) {
  const total = Math.abs(txn.amountCents);
  const sign = Math.sign(txn.amountCents) || -1;
  const [parts, setParts] = useState([
    { amount: "", categoryId: "" },
    { amount: "", categoryId: "" },
  ]);
  const [pending, startTransition] = useTransition();
  const entered = parts.slice(0, -1).map((p) => centsOf(p.amount));
  const rest = total - entered.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const valid = entered.every((c) => c !== null) && rest > 0 && parts.every((p) => p.categoryId);
  const set = (i: number, patch: Partial<(typeof parts)[number]>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <div key={i} className="flex gap-2">
            {last ? (
              <span className="flex h-11 w-24 shrink-0 items-center justify-end rounded-md border border-dashed px-2 tabular-nums text-muted-foreground">
                {rest > 0 ? formatCents(rest) : "—"}
              </span>
            ) : (
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={part.amount}
                onChange={(e) => set(i, { amount: e.target.value })}
                aria-label={`Part ${i + 1} amount`}
                className="h-11 w-24 shrink-0 rounded-md border bg-background px-2 text-right text-base tabular-nums"
              />
            )}
            <select
              value={part.categoryId}
              onChange={(e) => set(i, { categoryId: e.target.value })}
              aria-label={`Part ${i + 1} category`}
              className="h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-base"
            >
              <option value="">Category…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">The last part is whatever&apos;s left of {formatCents(total)}.</p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={parts.length >= 20}
          onClick={() => setParts([...parts.slice(0, -1), { amount: "", categoryId: "" }, parts.at(-1)!])}
        >
          Add part
        </Button>
        <Button
          className="flex-1"
          disabled={!valid || pending}
          onClick={() =>
            startTransition(async () => {
              const amounts = [...entered.map((c) => c!), rest];
              const result = await splitInto(
                txn.id,
                parts.map((p, i) => ({ amountCents: sign * amounts[i], categoryId: p.categoryId })),
              );
              onSaved(result, `Split into ${parts.length} parts`);
            })
          }
        >
          Save split
        </Button>
      </div>
    </div>
  );
}

export function QuickFile({ txn, choices, options }: { txn: Txn; choices: Choice[]; options: CategoryOption[] }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<{ label: string; commandId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "search" | "split">("choose");
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterOptions(options, query).slice(0, 8), [options, query]);

  const saved = (result: QuickResult, label: string) => {
    if ("error" in result) setError(result.error);
    else {
      setError(null);
      setDone({ label, commandId: result.commandId });
    }
  };
  const file = (categoryId: string, label: string) => startTransition(async () => saved(await fileAs(txn.id, categoryId), label));

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div className="space-y-1">
        <p className="text-3xl font-semibold tabular-nums">{formatCents(Math.abs(txn.amountCents))}</p>
        <h1 className="truncate text-xl">{txn.merchant}</h1>
        <p className="text-sm text-muted-foreground">
          {txn.postedOn} · {txn.accountName}
          {txn.provisional ? ` · from ${txn.provisional === "apple_pay" ? "Apple Pay" : "an email alert"}` : ""}
          {txn.amountCents > 0 ? " · money in" : ""}
        </p>
        {txn.current && !done ? <p className="text-sm">Currently: {txn.current}</p> : null}
      </div>

      {done ? (
        <div className="space-y-3 rounded-lg border p-4" role="status">
          <p className="text-lg">✓ {done.label}</p>
          <div className="flex gap-2">
            <Link href="/" className={buttonVariants({ className: "flex-1" })}>
              Done
            </Link>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await undo(done.commandId);
                  if ("error" in result) setError(result.error);
                  else setDone(null);
                })
              }
            >
              Undo
            </Button>
          </div>
        </div>
      ) : mode === "split" ? (
        <>
          <Split txn={txn} options={options} onSaved={saved} />
          <Button variant="ghost" className="w-full" onClick={() => setMode("choose")}>
            Back
          </Button>
        </>
      ) : (
        <>
          {choices.length ? (
            <div className="space-y-2">
              {choices.map((c) => (
                <Button key={c.categoryId} variant="outline" className={big} disabled={pending} onClick={() => file(c.categoryId, c.label)}>
                  <span className="truncate">{c.label}</span>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">{SOURCE[c.source]}</span>
                </Button>
              ))}
            </div>
          ) : null}

          {mode === "search" ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a category"
                aria-label="Find a category"
                className="h-12 w-full rounded-md border bg-background px-3 text-base"
              />
              {matches.map((o) => (
                <Button key={o.id} variant="ghost" className={`${big} justify-start`} disabled={pending} onClick={() => file(o.id, o.label)}>
                  {o.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-12 text-base" onClick={() => setMode("search")}>
                Other category
              </Button>
              <Button variant="secondary" className="h-12 text-base" onClick={() => setMode("split")}>
                Split
              </Button>
            </div>
          )}
        </>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-center text-sm">
        <Link href={`/transactions/${txn.id}`} className="text-muted-foreground underline">
          Tags, notes, sharing and more
        </Link>
      </p>
    </div>
  );
}
