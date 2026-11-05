"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { addTrade } from "./actions";
import { localToday, positive, select, SIDES, validSymbol } from "./fields";

// Adding a trade by hand (#319), for what nothing could infer: any account
// that takes trades, synced or manual. A manual account's positions follow
// its trades, so a symbol new to one asks what kind of asset it is (#244).
// ?account= and ?symbol= fill it in, as the Accounts page links here.

export type TradeAccount = { id: string; name: string; manual: boolean };

export function AddTrade({ accounts, account: initialAccount, symbol: initialSymbol }: { accounts: TradeAccount[]; account?: string; symbol?: string }) {
  const [accountId, setAccountId] = useState(initialAccount && accounts.some((a) => a.id === initialAccount) ? initialAccount : (accounts[0]?.id ?? ""));
  const [on, setOn] = useState(localToday);
  const [side, setSide] = useState<TradeSide>("buy");
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [kind, setKind] = useState<"crypto" | "equity">("crypto");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const account = accounts.find((a) => a.id === accountId);

  if (!accounts.length) return <p className="text-sm text-muted-foreground">No account takes trades yet: a brokerage or retirement account, or a manual asset account.</p>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = positive(quantity);
    const p = price.trim() ? positive(price) : null;
    if (!account) return setError("Pick an account");
    if (!validSymbol(symbol)) return setError("Symbol should be letters and digits, like ZZIX");
    if (!q) return setError("Quantity should be a positive number like 2.5");
    if (price.trim() && !p) return setError("Price should be a positive number, or left empty");
    startTransition(async () => {
      const result = await addTrade({ accountId, on, side, symbol: symbol.trim(), quantity: q, price: p, ...(account.manual ? { assetClass: kind } : {}) }, account.name);
      if (result?.error) return setError(result.error);
      setSymbol("");
      setQuantity("");
      setPrice("");
      setError(null);
      setDone(true);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2" onChange={() => setDone(false)}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={`${select} max-w-full`}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Input aria-label="Trade date" type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} className="h-8 w-40" />
        <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as TradeSide)} className={select}>
          {SIDES.map((s) => (
            <option key={s} value={s}>
              {SIDE_LABELS[s]}
            </option>
          ))}
        </select>
        <Input aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Symbol" maxLength={16} className="h-8 w-24" />
        <Input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="Quantity" className="h-8 w-28" />
        <Input aria-label="Price per unit" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price (optional)" className="h-8 w-32" />
        {account?.manual ? (
          <select aria-label="Kind of asset, for a new symbol" value={kind} onChange={(e) => setKind(e.target.value as "crypto" | "equity")} className={select}>
            <option value="crypto">Coin</option>
            <option value="equity">Stock or fund</option>
          </select>
        ) : null}
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Add trade
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {account?.manual
          ? "In a manual account, each position is what its trades add up to."
          : "In a synced account, positions still come from the sync; trades rebuild the past."}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {done ? <p className="text-xs text-positive">Recorded.</p> : null}
    </form>
  );
}
