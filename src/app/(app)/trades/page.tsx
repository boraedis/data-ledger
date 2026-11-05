import Link from "next/link";
import { inArray } from "drizzle-orm";
import { accounts as accountsTable, trades as tradesTable, transactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { planCashRows } from "@/lib/trades/cash-plan";
import { recognize } from "@/lib/trades/cash-rows";
import { hintQuantities, suggestionsFor } from "@/lib/trades/suggest-load";
import { read } from "@/operations/runtime";
import { listTradesRead } from "@/operations/trades";
import { listManualPositions } from "@/operations/holdings";
import { AddTrade, type AddTradeFill, type TradeAccount } from "./add-trade";
import { CashHints } from "./cash-hints";
import { DraftCard } from "./draft-card";
import { TradeItem } from "./trade-item";
import type { CashRowView } from "./fields";

// Trades (#319), in the Wealth section: every trade across accounts, with
// the drafts that need the owner first. A draft is a trade inferred from what
// a sync reports (#320, #321), partly filled in, counted nowhere until it's
// confirmed (#318). It replaces the trade log that sat on each account on
// the Accounts page, which links here now.
//
// Filters are a plain GET form, as on Transactions: every view is a URL.
// Drafts aren't filtered by status or date, only by account and symbol:
// they're what's waiting, and a filter shouldn't hide one.

const field = "h-9 rounded-md border bg-background px-2 text-sm";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const isDay = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const STATUSES = ["confirmed", "dismissed", "draft"] as const;

export default async function TradesPage(props: PageProps<"/trades">) {
  const sp = await props.searchParams;
  const db = getDb();
  const all = await db.select().from(accountsTable).orderBy(accountsTable.institution, accountsTable.name);
  // Which accounts take trades (#247): a manual asset account, or a synced brokerage or retirement one.
  const takesTrades = all.filter((a) => (a.source === "manual" ? a.type !== "loan" && a.type !== "credit" : (INVESTMENT_KINDS as readonly string[]).includes(a.type)));
  const tradeAccounts: TradeAccount[] = takesTrades.map((a) => ({ id: a.id, name: a.displayName ?? a.name, manual: a.source === "manual" }));
  const nameOf = new Map(tradeAccounts.map((a) => [a.id, a.name]));

  const account = one(sp.account);
  const accountId = account && nameOf.has(account) ? account : undefined;
  const symbol = one(sp.symbol)?.trim().slice(0, 16) || undefined;
  const statusParam = one(sp.status);
  const status = STATUSES.find((s) => s === statusParam);
  const from = isDay(one(sp.from));
  const to = isDay(one(sp.to));

  const [drafts, listed, cashPlan] = await Promise.all([
    read(db, listTradesRead, { status: "draft", accountId, symbol }),
    read(db, listTradesRead, { accountId, symbol, from, to, ...(status ? { status } : {}) }),
    planCashRows(db),
  ]);
  // The other end of each share transfer (#324), to name its account.
  const pairIds = drafts.flatMap((d) => (d.pairedTradeId ? [d.pairedTradeId] : []));
  const pairAccount = new Map(
    pairIds.length ? (await db.select({ id: tradesTable.id, accountId: tradesTable.accountId }).from(tradesTable).where(inArray(tradesTable.id, pairIds))).map((r) => [r.id, r.accountId]) : [],
  );
  // The cash rows drafts already have (#321), to show with them.
  const attachedIds = drafts.flatMap((d) => (d.transactionId ? [d.transactionId] : []));
  const attachedRows = attachedIds.length ? await db.select().from(transactions).where(inArray(transactions.id, attachedIds)) : [];
  const view = (r: { id: string; accountId: string; postedOn: string; amountCents: number; text: string }): CashRowView => {
    const seen = recognize(r);
    return { ...r, symbol: seen?.symbol ?? null, quantity: seen?.quantity ?? null, side: seen?.side ?? (r.amountCents < 0 ? "buy" : "sell") };
  };
  const attached = new Map(
    attachedRows.map((r) => [r.id, view({ id: r.id, accountId: r.accountId, postedOn: r.postedOn, amountCents: r.amountCents, text: [r.description, r.payee, r.memo].filter(Boolean).join(" ") })]),
  );
  const [suggested, quantities, positions] = await Promise.all([
    suggestionsFor(db, drafts),
    hintQuantities(db, cashPlan.hints),
    listManualPositions(db),
  ]);
  const held = Object.fromEntries(positions.map((p) => [`${p.accountId}:${p.symbol.toUpperCase()}`, p.quantity]));
  const hints = cashPlan.hints
    .filter((h) => !accountId || h.accountId === accountId)
    .map((h) => {
      const q = quantities.get(h.id);
      return { ...view(h), ...(q ? { suggestedQuantity: { value: q.value, basis: q.basis } } : {}) };
    });
  const fill: AddTradeFill = {
    account: accountId,
    symbol,
    side: (["buy", "sell", "transfer_in", "transfer_out"] as const).find((x) => x === one(sp.side)),
    on: isDay(one(sp.on)),
    quantity: one(sp.quantity)?.slice(0, 32),
    price: one(sp.price)?.slice(0, 32),
    cash: one(sp.cash)?.slice(0, 64),
  };
  // Drafts have their own section above; the list is everything else unless asked for.
  const rows = status ? listed : listed.filter((t) => t.status !== "draft");
  const manual = new Set(tradeAccounts.filter((a) => a.manual).map((a) => a.id));
  const filtered = Boolean(accountId || symbol || status || from || to);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Trades</h1>
        <p className="text-sm text-muted-foreground">
          Buys, sells and share transfers in your investment accounts. In a manual account each position is what its trades add up to; in a synced one,
          trades rebuild what you held in the past. A draft counts nowhere until you confirm it.
        </p>
      </div>

      <section className="space-y-2" aria-labelledby="drafts">
        <h2 id="drafts" className="text-lg font-medium">
          Needs you{drafts.length ? ` (${drafts.length})` : ""}
        </h2>
        {drafts.length ? (
          <ul className="space-y-2">
            {drafts.map((t) => (
              <DraftCard
                key={t.id}
                trade={t}
                accountName={nameOf.get(t.accountId) ?? "An account"}
                drivesPositions={manual.has(t.accountId)}
                cash={t.transactionId ? (attached.get(t.transactionId) ?? null) : null}
                offers={(cashPlan.offers.get(t.id) ?? []).map(view)}
                suggested={suggested.get(t.id) ?? { suggestions: [], notes: [] }}
                otherAccount={t.pairedTradeId ? nameOf.get(pairAccount.get(t.pairedTradeId) ?? "") : undefined}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No drafts waiting.</p>
        )}
      </section>

      {hints.length ? (
        <section className="space-y-2" aria-labelledby="hints">
          <h2 id="hints" className="text-lg font-medium">
            Cash rows with no trade ({hints.length})
          </h2>
          <p className="text-sm text-muted-foreground">Buys and sells your brokerage reported, with no change in shares to go with them yet.</p>
          <CashHints hints={hints} accountName={Object.fromEntries(nameOf)} />
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby="add-heading" id="add">
        <h2 id="add-heading" className="text-lg font-medium">
          Add a trade
        </h2>
        <AddTrade key={JSON.stringify(fill)} accounts={tradeAccounts} fill={fill} held={held} />
      </section>

      <section className="space-y-3" aria-labelledby="all">
        <h2 id="all" className="text-lg font-medium">
          All trades
        </h2>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Account</span>
            <select name="account" defaultValue={accountId ?? ""} className={`${field} max-w-full`}>
              <option value="">All accounts</option>
              {tradeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Status</span>
            <select name="status" defaultValue={status ?? ""} className={field}>
              <option value="">Confirmed and dismissed</option>
              <option value="confirmed">Confirmed</option>
              <option value="dismissed">Dismissed</option>
              <option value="draft">Drafts</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Symbol</span>
            <input name="symbol" defaultValue={symbol ?? ""} maxLength={16} className={`${field} w-24`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">From</span>
            <input type="date" name="from" defaultValue={from ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">To</span>
            <input type="date" name="to" defaultValue={to ?? ""} className={field} />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 hover:bg-accent">
            Filter
          </button>
          {filtered ? (
            <Link href="/trades" className="h-9 px-1 py-2 text-muted-foreground underline underline-offset-2">
              Clear
            </Link>
          ) : null}
        </form>
        {rows.length ? (
          <ul className="divide-y rounded-lg border">
            {rows.map((t) => (
              <TradeItem key={t.id} trade={t} accountName={nameOf.get(t.accountId) ?? "An account"} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{filtered ? "No trades match." : "No trades yet."}</p>
        )}
      </section>
    </div>
  );
}
