"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeQuantity } from "@/lib/holdings/value";
import { dollarFigure, formatCents, parseAmountCents } from "@/lib/money";
import { priceTime } from "@/lib/prices/describe";
import type { ManualPosition } from "@/operations/holdings";
import { addPosition, removePastPrice, removePosition, setHeldSince, setPastPrice, setPositionAssetClass, setPositionPrice } from "./actions";

// Positions kept by hand in a manual account (#231): crypto, say, until a
// connection covers it. Each is a symbol, how much is held and a price per
// unit with its date; the account's value is their total, recorded as that
// day's value on every change. Until live prices (#229), every price here
// is the owner's, so its date is always shown.

// What kind of asset a position is decides where its market price comes
// from (#244): Coinbase for coins, Tiingo for stocks, ETFs and funds.
type AssetClass = ManualPosition["assetClass"];
const KINDS: { value: AssetClass; label: string }[] = [
  { value: "crypto", label: "Coins and tokens" },
  { value: "equity", label: "Stocks, ETFs and funds" },
];

/** Today in the owner's own time zone. */
function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** "61234.5" → "$61,234.50"; a price finer than a cent keeps its places ("$0.00001234"). */
function formatPrice(price: string): string {
  const [whole, fraction = ""] = price.split(".");
  return dollarFigure(`$${Number(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`);
}

const formatQuantity = (q: string) => {
  const [whole, fraction] = q.split(".");
  return `${Number(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
};

/** An optional total cost: "" → null, "1,200.50" → 120050, anything else → undefined (invalid). */
function parseCost(text: string): number | null | undefined {
  const plain = text.replace(/[$,\s]/g, "");
  if (!plain) return null;
  try {
    const cents = parseAmountCents(plain);
    return cents >= 0 ? cents : undefined;
  } catch {
    return undefined;
  }
}

// The market price from the price cache (#229), when the symbol has been
// looked up: null price means the provider has none. Shown beside the
// owner's own price. The value here is at the owner's price, what's recorded;
// net worth values it live at the market price (#230).
export type PositionWithMarket = ManualPosition & { market: { price: string | null; asOf: string | null; stale: boolean } | null };



function MarketPrice({ symbol, market }: { symbol: string; market: PositionWithMarket["market"] }) {
  if (!market) return null;
  if (market.price === null) return <span>No market price for {symbol}</span>;
  const when = market.asOf ? priceTime(new Date(market.asOf)) : "";
  return (
    <span className={market.stale ? "text-warning" : undefined}>
      Market {formatPrice(market.price)} · {market.stale ? `stale, from ${when}` : when}
    </span>
  );
}

export function Positions({ account, positions }: { account: { id: string; name: string }; positions: PositionWithMarket[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-2">
      {positions.length ? (
        <ul className="divide-y rounded-md border">
          {positions.map((p) => (
            <PositionRow key={p.id} position={p} accountId={account.id} />
          ))}
        </ul>
      ) : null}
      {adding ? (
        <AddPosition account={account} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setAdding(true)}>
          {positions.length ? "Add a position" : "Hold positions here instead (crypto, say)"}
        </Button>
      )}
    </div>
  );
}

// How much is held changes only by a trade, recorded on the Trades page
// (#319): one way to do it, so a quantity is always what its trades add up to.
function PositionRow({ position: p, accountId }: { position: PositionWithMarket; accountId: string }) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(p.unitPrice);
  const [priceOn, setPriceOn] = useState(localToday);
  const [kind, setKind] = useState<AssetClass>(p.assetClass);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const u = normalizeQuantity(price);
    if (!u || !/[1-9]/.test(u)) return setError("Price should be a positive number like 61,234.50");
    startTransition(async () => {
      // Separate operations, each logged and undoable on its own: what it's worth, and what kind it is.
      const results = [
        u !== p.unitPrice || priceOn !== p.priceOn ? await setPositionPrice(p.id, p.symbol, u, priceOn) : undefined,
        kind !== p.assetClass ? await setPositionAssetClass(p.id, p.symbol, kind) : undefined,
      ];
      const failed = results.find((r) => r?.error);
      setError(failed?.error ?? null);
      if (!failed) setEditing(false);
    });
  };

  const remove = () => {
    if (!confirm(`Remove ${p.symbol}? You can undo this from Activity.`)) return;
    startTransition(async () => setError((await removePosition(p.id, p.symbol))?.error ?? null));
  };

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span>
          <span className="font-medium">{p.symbol}</span>{" "}
          <span className="text-xs text-muted-foreground">{p.assetClass === "equity" ? "stock or fund" : "coin"}</span>{" "}
          <span className="text-muted-foreground tabular-nums">
            {formatQuantity(p.quantity)} × {formatPrice(p.unitPrice)}
          </span>
        </span>
        <span className="tabular-nums">{formatCents(p.valueCents)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        <MarketPrice symbol={p.symbol} market={p.market} />
        {p.market ? " · " : ""}
        Your price, as of {p.priceOn}
        {p.costBasisCents !== null ? ` · cost ${formatCents(p.costBasisCents)}` : ""}
        {p.heldSince ? ` · held since ${p.heldSince}` : ""} ·{" "}
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Update"}
        </button>{" "}
        ·{" "}
        <Link href={`/trades?account=${accountId}&symbol=${encodeURIComponent(p.symbol)}#add`} className="underline underline-offset-2 hover:text-foreground">
          Buy or sell
        </Link>{" "}
        ·{" "}
        <button type="button" className="underline underline-offset-2 hover:text-destructive" onClick={remove} disabled={pending}>
          Remove
        </button>
      </p>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Price</span>
          <Input aria-label={`${p.symbol} price per unit`} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="h-8 w-32" />
          <Input aria-label="Price as of" type="date" value={priceOn} max={localToday()} onChange={(e) => setPriceOn(e.target.value)} className="h-8 w-40" />
          <select aria-label="Kind of asset" value={kind} onChange={(e) => setKind(e.target.value as AssetClass)} className="h-8 rounded-md border bg-background px-2 text-sm">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Save
          </Button>
        </form>
      ) : null}
      {editing ? <PastControls position={p} /> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

// The position's past (#340): since when it's been held, and, where no
// market feed prices it, prices of your own on past days. Its history is
// valued from the latest of those on or before each day; days before the
// first aren't drawn, since carrying a price back would invent value.
function PastControls({ position: p }: { position: PositionWithMarket }) {
  const [heldSince, setHeldSinceValue] = useState(p.heldSince ?? localToday());
  const [on, setOn] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const symbol = p.symbol.toUpperCase();
  const unpriced = !p.market?.price;

  const moveStart = () =>
    startTransition(async () => setError(heldSince === p.heldSince ? null : ((await setHeldSince(p.id, symbol, heldSince))?.error ?? null)));
  const addPrice = () => {
    const u = normalizeQuantity(price);
    if (!on) return setError("Pick the day the price is from");
    if (!u || !/[1-9]/.test(u)) return setError("Price should be a positive number like 61,234.50");
    startTransition(async () => {
      const result = await setPastPrice(p.id, symbol, on, u);
      setError(result?.error ?? null);
      if (!result?.error) {
        setOn("");
        setPrice("");
      }
    });
  };

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Held since</span>
        <Input aria-label={`${symbol} held since`} type="date" value={heldSince} max={localToday()} onChange={(e) => setHeldSinceValue(e.target.value)} className="h-8 w-40" />
        <Button type="button" size="sm" variant="outline" onClick={moveStart} disabled={pending || heldSince === p.heldSince}>
          Change
        </Button>
        <span className="text-muted-foreground">Its history starts here. To change how much was held before, add a dated buy or sell.</span>
      </div>
      {unpriced ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">No market price covers {symbol}, so its history uses your prices: each day takes the latest one on or before it.</p>
          {p.pastPrices.length ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {p.pastPrices.map((x) => (
                <li key={x.on} className="tabular-nums">
                  {x.on}: {formatPrice(x.price)}{" "}
                  <button
                    type="button"
                    className="text-muted-foreground underline underline-offset-2 hover:text-destructive"
                    onClick={() => startTransition(async () => setError((await removePastPrice(p.id, symbol, x.on))?.error ?? null))}
                    disabled={pending}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Day of the price" type="date" value={on} max={localToday()} onChange={(e) => setOn(e.target.value)} className="h-8 w-40" />
            <Input aria-label="Price on that day" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price" className="h-8 w-32" />
            <Button type="button" size="sm" variant="outline" onClick={addPrice} disabled={pending}>
              Add a past price
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

function AddPosition({ account, onDone }: { account: { id: string; name: string }; onDone: () => void }) {
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [priceOn, setPriceOn] = useState(localToday);
  // Since when it's been held (#340): its history starts there.
  const [heldSince, setHeldSinceValue] = useState(localToday);
  const [cost, setCost] = useState("");
  const [kind, setKind] = useState<AssetClass>("crypto");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = normalizeQuantity(quantity);
    const u = normalizeQuantity(price);
    const costBasisCents = parseCost(cost);
    if (!/^[A-Za-z0-9.\-]{1,16}$/.test(symbol.trim())) return setError("Symbol should be letters and digits, like BTC");
    if (!q || !/[1-9]/.test(q)) return setError("Quantity should be a positive number like 0.5");
    if (!u || !/[1-9]/.test(u)) return setError("Price should be a positive number like 61,234.50");
    if (costBasisCents === undefined) return setError("Total cost should be an amount like 1,200.00, or left empty");
    startTransition(async () => {
      const result = await addPosition({ accountId: account.id, symbol: symbol.trim(), quantity: q, unitPrice: u, priceOn, costBasisCents, assetClass: kind, heldSince }, account.name);
      if (result?.error) return setError(result.error);
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        The account&apos;s value becomes the total of its positions: quantity × your price. Live prices come later; until then,
        update a price whenever you like.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Symbol</span>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. BTC" maxLength={16} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Quantity</span>
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="0.5" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Price per unit ($)</span>
          <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Price as of</span>
          <Input type="date" value={priceOn} max={localToday()} onChange={(e) => setPriceOn(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as AssetClass)} className="h-8 w-full rounded-md border bg-background px-2 text-sm">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Held since</span>
          <Input type="date" value={heldSince} max={localToday()} onChange={(e) => setHeldSinceValue(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Total cost (optional)</span>
          <Input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
