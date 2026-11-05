"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { normalizeQuantity } from "@/lib/holdings/value";
import type { TradeMismatch, TradeRow } from "@/operations/trades";
import { addTrade, removeTrade, updateTrade } from "./actions";

// An account's confirmed trades (#247, #318): dated buys, sells and share
// transfers, so past holdings can be rebuilt (#232). In a manual account the
// positions follow them; in a synced brokerage the positions come from the
// sync, and any symbol where the trades don't add up to what it reports is
// called out, since a trade is missing or mistyped. Drafts aren't shown
// here: they get the Trades page (#319), which replaces this log.

function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const SIDES = Object.keys(SIDE_LABELS) as TradeSide[];
const positive = (text: string) => {
  const n = normalizeQuantity(text);
  return n && /[1-9]/.test(n) ? n : null;
};

export function TradeLog({
  account,
  trades,
  mismatches,
  drivesPositions,
}: {
  account: { id: string; name: string };
  trades: TradeRow[];
  mismatches: TradeMismatch[];
  drivesPositions: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="text-sm" open={open || mismatches.length > 0} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Trades{trades.length ? ` (${trades.length})` : ""}
        {mismatches.length ? <span className="text-warning"> · {mismatches.length} not matching what the brokerage reports</span> : null}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          {drivesPositions
            ? "Each position here is what its trades add up to. Trades also let the past be rebuilt."
            : "Trades here only rebuild the past; today's positions still come from the bank sync."}
        </p>
        {mismatches.length ? (
          <ul className="space-y-0.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
            {mismatches.map((m) => (
              <li key={m.symbol} className="tabular-nums">
                <span className="font-medium">{m.symbol}</span>: your trades add up to {m.traded}, the brokerage reports {m.synced} (
                {m.difference.startsWith("-") ? m.difference : `+${m.difference}`})
              </li>
            ))}
          </ul>
        ) : null}
        {trades.length ? (
          <ul className="divide-y rounded-md border">
            {trades.map((t) => (
              <TradeItem key={t.id} trade={t} />
            ))}
          </ul>
        ) : null}
        <AddTrade account={account} drivesPositions={drivesPositions} />
      </div>
    </details>
  );
}

function TradeItem({ trade: t }: { trade: TradeRow }) {
  const [editing, setEditing] = useState(false);
  const [on, setOn] = useState(t.on);
  const [side, setSide] = useState<TradeSide>(t.side);
  const [quantity, setQuantity] = useState(t.quantity);
  const [price, setPrice] = useState(t.price ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
    if (!confirm(`Remove this ${t.label.toLowerCase()} of ${t.symbol}? You can undo this from Activity.`)) return;
    startTransition(async () => setError((await removeTrade(t.id, t.symbol))?.error ?? null));
  };

  return (
    <li className="space-y-1 px-3 py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="tabular-nums">
          {t.on} · {t.label} <span className="font-medium">{t.symbol}</span> {t.quantity}
          {t.price ? <span className="text-muted-foreground"> at ${t.price}</span> : null}
        </span>
        <span className="flex gap-2 text-xs text-muted-foreground">
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Edit"}
          </button>
          <button type="button" className="underline underline-offset-2 hover:text-destructive" onClick={remove} disabled={pending}>
            Remove
          </button>
        </span>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Date" type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} className="h-8 w-40" />
          <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as TradeSide)} className="h-8 rounded-md border bg-background px-2 text-sm">
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

function AddTrade({ account, drivesPositions }: { account: { id: string; name: string }; drivesPositions: boolean }) {
  const [on, setOn] = useState(localToday);
  const [side, setSide] = useState<TradeSide>("buy");
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  // For a symbol new to a manual account: what kind of asset it is, so it's priced by the right source (#244).
  const [kind, setKind] = useState<"crypto" | "equity">("crypto");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = positive(quantity);
    const p = price.trim() ? positive(price) : null;
    if (!/^[A-Za-z0-9.\-]{1,16}$/.test(symbol.trim())) return setError("Symbol should be letters and digits, like ZZIX");
    if (!q) return setError("Quantity should be a positive number like 2.5");
    if (price.trim() && !p) return setError("Price should be a positive number, or left empty");
    startTransition(async () => {
      const result = await addTrade(
        { accountId: account.id, on, side, symbol: symbol.trim(), quantity: q, price: p, ...(drivesPositions ? { assetClass: kind } : {}) },
        account.name,
      );
      if (result?.error) return setError(result.error);
      setSymbol("");
      setQuantity("");
      setPrice("");
      setError(null);
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input aria-label="Trade date" type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} className="h-8 w-40" />
      <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as TradeSide)} className="h-8 rounded-md border bg-background px-2 text-sm">
        {SIDES.map((s) => (
          <option key={s} value={s}>
            {SIDE_LABELS[s]}
          </option>
        ))}
      </select>
      <Input aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Symbol" maxLength={16} className="h-8 w-24" />
      <Input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="Quantity" className="h-8 w-28" />
      <Input aria-label="Price per unit" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price (optional)" className="h-8 w-32" />
      {drivesPositions ? (
        <select
          aria-label="Kind of asset, for a new symbol"
          value={kind}
          onChange={(e) => setKind(e.target.value as "crypto" | "equity")}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="crypto">Coin</option>
          <option value="equity">Stock or fund</option>
        </select>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Add trade
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
