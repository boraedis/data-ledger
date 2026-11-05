"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import type { TradeRow } from "@/operations/trades";
import { removeTrade, restoreTrade, updateTrade } from "./actions";
import { localToday, positive, select, SIDES, SOURCE_LABELS, when } from "./fields";

// A confirmed or dismissed trade in the Trades page's list (#319): edit or
// remove a confirmed one, restore a dismissed one to the drafts.

const CHIPS = {
  draft: "rounded bg-warning/15 px-1.5 text-warning",
  confirmed: "rounded border px-1.5 text-muted-foreground",
  dismissed: "rounded border border-dashed px-1.5 text-muted-foreground",
} as const;

export function StatusChip({ status }: { status: TradeRow["status"] }) {
  return <span className={`text-xs ${CHIPS[status]}`}>{status === "draft" ? "Draft" : status === "confirmed" ? "Confirmed" : "Dismissed"}</span>;
}

export function TradeItem({ trade: t, accountName }: { trade: TradeRow; accountName: string }) {
  const [editing, setEditing] = useState(false);
  const [on, setOn] = useState(t.on);
  const [side, setSide] = useState<TradeSide>(t.side);
  const [quantity, setQuantity] = useState(t.quantity);
  const [price, setPrice] = useState(t.price ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const name = t.symbol ?? "a position with no symbol";

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const q = positive(quantity);
    const p = price.trim() ? positive(price) : null;
    if (!q) return setError("Quantity should be a positive number like 2.5");
    if (price.trim() && !p) return setError("Price should be a positive number, or left empty");
    startTransition(async () => {
      const result = await updateTrade(t.id, t.symbol, { on, side, quantity: q, price: p });
      setError(result?.error ?? null);
      if (!result?.error) setEditing(false);
    });
  };

  const remove = () => {
    if (!confirm(`Remove this ${t.label.toLowerCase()} of ${name}? You can undo this from Activity.`)) return;
    startTransition(async () => setError((await removeTrade(t.id, t.symbol))?.error ?? null));
  };
  const restore = () => startTransition(async () => setError((await restoreTrade(t.id, t.symbol))?.error ?? null));

  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 tabular-nums">
          {t.label} <span className="font-medium">{name}</span> {t.quantity}
          {t.price ? <span className="text-muted-foreground"> at ${t.price}</span> : null}
          <span className="block text-xs text-muted-foreground">
            {when(t)} · {accountName} · {SOURCE_LABELS[t.source]}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusChip status={t.status} />
          {t.status === "confirmed" ? (
            <>
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Edit"}
              </button>
              <button type="button" className="underline underline-offset-2 hover:text-destructive" onClick={remove} disabled={pending}>
                Remove
              </button>
            </>
          ) : (
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={restore} disabled={pending}>
              Restore to drafts
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Date" type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} className="h-8 w-40" />
          <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as TradeSide)} className={select}>
            {SIDES.map((s) => (
              <option key={s} value={s}>
                {SIDE_LABELS[s]}
              </option>
            ))}
          </select>
          <Input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" className="h-8 w-28" />
          <Input aria-label="Price per unit" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price (optional)" className="h-8 w-32" />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Save
          </Button>
        </form>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
