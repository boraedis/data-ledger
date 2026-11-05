"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import type { TradeRow } from "@/operations/trades";
import { formatCents } from "@/lib/money";
import { attachCash, detachCash, dismissTrade, finishAndConfirm, updateTrade } from "./actions";
import { draftHeadline, missing, positive, select, SIDES, SOURCE_LABELS, validSymbol, type CashRowView } from "./fields";

// One draft trade to finish (#319): what's known, what's missing and where
// it came from, with the fields to fill in, and Confirm or Dismiss in place.
// Nothing here counts until it's confirmed (#318).

export function DraftCard({
  trade: t,
  accountName,
  drivesPositions,
  cash,
  offers,
}: {
  trade: TradeRow;
  accountName: string;
  drivesPositions: boolean;
  // The cash row it settled through, and rows it could be when that's not certain (#321).
  cash: CashRowView | null;
  offers: CashRowView[];
}) {
  const [symbol, setSymbol] = useState(t.symbol ?? "");
  const [side, setSide] = useState<TradeSide>(t.side);
  // A draft with a range starts with no day picked: picking one is the owner's call.
  const [on, setOn] = useState(t.onFrom ? "" : t.on);
  const [quantity, setQuantity] = useState(t.quantity);
  const [price, setPrice] = useState(t.price ?? "");
  const [kind, setKind] = useState<"crypto" | "equity">("equity");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { needed, optional } = missing(t);

  // Only what the owner changed, so each change reads plainly in Activity.
  const changes = () => {
    const q = positive(quantity);
    const p = price.trim() ? positive(price) : null;
    if (symbol.trim() && !validSymbol(symbol)) return { error: "Symbol should be letters and digits, like ZZIX" };
    if (!q) return { error: "Quantity should be a positive number like 2.5" };
    if (price.trim() && !p) return { error: "Price should be a positive number, or left empty" };
    const out: Parameters<typeof updateTrade>[2] = {};
    if (symbol.trim() && symbol.trim().toUpperCase() !== t.symbol) out.symbol = symbol.trim();
    if (side !== t.side) out.side = side;
    if (on && (on !== t.on || t.onFrom)) Object.assign(out, { on, onFrom: null });
    if (q !== t.quantity) out.quantity = q;
    if (p !== t.price) out.price = p;
    return { changes: out };
  };

  const act = (confirming: boolean) => {
    const c = changes();
    if ("error" in c) return setError(c.error ?? null);
    if (confirming && !symbol.trim()) return setError("Give it a symbol to confirm it");
    if (confirming && !on) return setError("Pick the day it happened to confirm it");
    startTransition(async () => {
      const result = confirming
        ? await finishAndConfirm(t.id, t.symbol, c.changes, drivesPositions ? kind : undefined)
        : Object.keys(c.changes).length
          ? await updateTrade(t.id, t.symbol, c.changes)
          : undefined;
      setError(result?.error ?? null);
    });
  };

  const dismiss = () => startTransition(async () => setError((await dismissTrade(t.id, t.symbol))?.error ?? null));
  const attach = (rowId: string) => startTransition(async () => setError((await attachCash(t.id, rowId, t.symbol))?.error ?? null));
  const detach = () => startTransition(async () => setError((await detachCash(t.id, t.symbol))?.error ?? null));

  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium">{draftHeadline(t)}</p>
        <p className="text-xs text-muted-foreground">
          {accountName} · {SOURCE_LABELS[t.source]}
          {t.positionId && !t.symbol ? " · position id only" : ""}
        </p>
        {needed.length || optional.length ? (
          <p className="text-xs">
            {needed.length ? <span className="text-warning">Needs {needed.join(" and ")}</span> : <span className="text-muted-foreground">Ready to confirm</span>}
            {optional.length ? <span className="text-muted-foreground"> · {optional.join(", ")}</span> : null}
          </p>
        ) : null}
      </div>
      {cash ? (
        <p className="text-xs text-muted-foreground">
          Cash row: {cash.postedOn} · <span className="tabular-nums">{formatCents(cash.amountCents)}</span> · {cash.text} ·{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={detach} disabled={pending}>
            Take it off
          </button>
        </p>
      ) : offers.length ? (
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">{offers.length === 1 ? "This cash row could be it:" : "One of these cash rows could be it:"}</p>
          <ul className="space-y-1">
            {offers.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums">
                  {o.postedOn} · {formatCents(o.amountCents)}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">{o.text}</span>
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => attach(o.id)} disabled={pending}>
                  Attach
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Symbol" maxLength={16} className="h-8 w-24" />
        <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as TradeSide)} className={select}>
          {SIDES.map((s) => (
            <option key={s} value={s}>
              {SIDE_LABELS[s]}
            </option>
          ))}
        </select>
        <Input
          aria-label={t.onFrom ? `The day it happened, from ${t.onFrom} to ${t.on}` : "Date"}
          type="date"
          value={on}
          min={t.onFrom ?? undefined}
          max={t.onFrom ? t.on : undefined}
          onChange={(e) => setOn(e.target.value)}
          className="h-8 w-40"
        />
        <Input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" className="h-8 w-28" />
        <Input aria-label="Price per unit" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price (optional)" className="h-8 w-32" />
        {drivesPositions ? (
          <select aria-label="Kind of asset, for a new symbol" value={kind} onChange={(e) => setKind(e.target.value as "crypto" | "equity")} className={select}>
            <option value="equity">Stock or fund</option>
            <option value="crypto">Coin</option>
          </select>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => act(true)} disabled={pending}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => act(false)} disabled={pending}>
          Save as draft
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={dismiss} disabled={pending}>
          Dismiss
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
