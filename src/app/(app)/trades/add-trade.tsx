"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIDE_LABELS, type TradeSide } from "@/lib/holdings/replay";
import { holdingsOn } from "@/lib/holdings/replay";
import { addTrade } from "./actions";
import { localToday, positive, select, SIDES, validSymbol } from "./fields";

// Adding a trade by hand (#319), for what nothing could infer: any account
// that takes trades, synced or manual. A manual account's positions follow
// its trades, so a symbol new to one asks what kind of asset it is (#244).
// ?account= and ?symbol= fill it in, as the Accounts page links here.

export type TradeAccount = { id: string; name: string; manual: boolean };

export type AddTradeFill = { account?: string; symbol?: string; side?: TradeSide; on?: string; quantity?: string; price?: string; cash?: string };

// held: a manual account's quantities today, by "accountId:SYMBOL", so a
// back-dated buy or sell says what it does to today's (#340).
export function AddTrade({ accounts, fill = {}, held = {} }: { accounts: TradeAccount[]; fill?: AddTradeFill; held?: Record<string, string> }) {
  const { account: initialAccount, symbol: initialSymbol } = fill;
  const [accountId, setAccountId] = useState(initialAccount && accounts.some((a) => a.id === initialAccount) ? initialAccount : (accounts[0]?.id ?? ""));
  const [on, setOn] = useState(fill.on ?? localToday());
  const [side, setSide] = useState<TradeSide>(fill.side ?? "buy");
  // A cash row it settled through, when it came from a hint (#321); dropped once used.
  const [cash, setCash] = useState(fill.cash);
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  const [quantity, setQuantity] = useState(fill.quantity ?? "");
  const [price, setPrice] = useState(fill.price ?? "");
  const [kind, setKind] = useState<"crypto" | "equity">("crypto");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const account = accounts.find((a) => a.id === accountId);
  // In a manual account, its positions are its trades: say what this one does to today's quantity.
  const now = account?.manual && symbol.trim() ? (held[`${accountId}:${symbol.trim().toUpperCase()}`] ?? "0") : null;
  const q = positive(quantity);
  const after =
    now !== null && q
      ? (holdingsOn([
          { on: "1970-01-01", symbol: "x", side: "buy", quantity: now === "0" ? "0" : now },
          { on: "1970-01-02", symbol: "x", side, quantity: q },
        ]).get("x") ?? "0")
      : null;

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
      const result = await addTrade(
        { accountId, on, side, symbol: symbol.trim(), quantity: q, price: p, ...(account.manual ? { assetClass: kind } : {}), ...(cash ? { transactionId: cash } : {}) },
        account.name,
      );
      if (result?.error) return setError(result.error);
      setSymbol("");
      setQuantity("");
      setPrice("");
      setCash(undefined);
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
      {after !== null ? (
        <p className="text-xs">
          {after.startsWith("-")
            ? `That's more ${symbol.trim().toUpperCase()} than this account holds (${now}).`
            : `${symbol.trim().toUpperCase()} held today: ${now} → ${after}${on < localToday() ? `, from ${on} on` : ""}.`}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {account?.manual
          ? "In a manual account, each position is what its trades add up to."
          : "In a synced account, positions still come from the sync; trades rebuild the past."}
      </p>
      {cash ? <p className="text-xs text-muted-foreground">Filled in from a cash row, which this trade will be linked to.</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {done ? <p className="text-xs text-positive">Recorded.</p> : null}
    </form>
  );
}
