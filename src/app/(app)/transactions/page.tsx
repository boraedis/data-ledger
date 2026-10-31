import Link from "next/link";
import { ACTIVITY_LABELS } from "@/lib/investments/activity";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { manualMatches } from "@/operations/manual";
import { listTransactions } from "@/operations/transactions";

const PAGE_SIZE = 100;
const select = "h-9 rounded-md border bg-background px-2 text-sm";

function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : undefined;
}

const isDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

// Every transaction, filterable. The filter is a plain GET form: no client
// JavaScript, and every filtered view is a shareable, back-button-friendly
// URL. Rows open the detail page, where splitting and tagging happen.
// ?unmatched=1 lists transfers with no other half (#184); ?from= and ?to=
// limit it to posted dates, as the Cash flow page links to its own period.
export default async function TransactionsPage(props: PageProps<"/transactions">) {
  const sp = await props.searchParams;
  const filters = {
    search: param(sp.q),
    categoryId: param(sp.category),
    tagId: param(sp.tag),
    accountId: param(sp.account),
    unmatchedTransfers: param(sp.unmatched) === "1",
    from: isDay(param(sp.from)),
    to: isDay(param(sp.to)),
  };
  const page = Math.max(Number(param(sp.page) ?? 1) || 1, 1);

  const db = getDb();
  const [rows, cats, tagList, accts, toMerge, unmatched] = await Promise.all([
    read(db, listTransactions, { ...filters, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    read(db, listCategories, {}),
    read(db, listTags, {}),
    read(db, listAccounts, {}),
    read(db, manualMatches, {}),
    // All of them, whatever the other filters: the count shown on the option.
    read(db, listTransactions, { unmatchedTransfers: true, limit: 500 }),
  ]);
  const unmatchedLabel = unmatched.length >= 500 ? "500+" : String(unmatched.length);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));
  const accountName = new Map(accts.map((a) => [a.id, a.name]));

  // Dates default to the view's own; pass {} to drop them.
  const pageHref = (p: number, dates: { from?: string; to?: string } = filters) => {
    const q = new URLSearchParams();
    if (filters.search) q.set("q", filters.search);
    if (filters.categoryId) q.set("category", filters.categoryId);
    if (filters.tagId) q.set("tag", filters.tagId);
    if (filters.accountId) q.set("account", filters.accountId);
    if (filters.unmatchedTransfers) q.set("unmatched", "1");
    if (dates.from) q.set("from", dates.from);
    if (dates.to) q.set("to", dates.to);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/transactions?${s}` : "/transactions";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <Link href="/transactions/new" className="h-9 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
          Add transaction
        </Link>
      </div>
      {toMerge.length ? (
        // Added by hand, and now the bank has something just like it: the
        // owner decides (#64); until then only the bank's counts.
        <details className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" open={toMerge.length <= 3}>
          <summary className="cursor-pointer">
            {toMerge.length} you added by hand {toMerge.length === 1 ? "looks" : "look"} like {toMerge.length === 1 ? "one" : "ones"} the bank
            reported: merge or keep both
          </summary>
          <ul className="mt-2 divide-y divide-warning/30 text-foreground">
            {toMerge.map((m) => (
              <li key={m.id}>
                <Link href={`/transactions/${m.id}`} className="flex justify-between gap-3 py-1.5 hover:underline">
                  <span className="min-w-0 truncate">
                    {m.postedOn} · {m.accountName} · {m.description}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCents(m.amountCents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <form className="flex flex-wrap items-center gap-2" action="/transactions">
        <input
          name="q"
          defaultValue={filters.search}
          placeholder="Search merchant or description"
          aria-label="Search"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:max-w-xs"
        />
        <select name="category" defaultValue={filters.categoryId ?? ""} aria-label="Category" className={select}>
          <option value="">All categories</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select name="tag" defaultValue={filters.tagId ?? ""} aria-label="Tag" className={select}>
          <option value="">All tags</option>
          {tagList.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.name}
            </option>
          ))}
        </select>
        <select name="account" defaultValue={filters.accountId ?? ""} aria-label="Account" className={select}>
          <option value="">All accounts</option>
          {/* Manual accounts hold a value, never transactions. */}
          {accts.filter((a) => !a.manual).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select name="unmatched" defaultValue={filters.unmatchedTransfers ? "1" : ""} aria-label="Unmatched" className={select}>
          <option value="">All transactions</option>
          {/* Transfers with no other half, with how many there are (#184). */}
          <option value="1">Unmatched transfers ({unmatchedLabel})</option>
        </select>
        {/* The Cash flow link carries its period; the form would drop it without these. */}
        {filters.from ? <input type="hidden" name="from" value={filters.from} /> : null}
        {filters.to ? <input type="hidden" name="to" value={filters.to} /> : null}
        <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-accent">
          Filter
        </button>
        {Object.values(filters).some(Boolean) ? (
          <>
            <Link href="/transactions" className="text-sm text-muted-foreground underline">
              Clear
            </Link>
            {/* Everything this filter shows, filed somewhere else at once (#116). The move page reads the
                category, tag, account and search only, so with an unmatched or dated view it would move
                more than is shown; those views leave the link out. */}
            {filters.unmatchedTransfers || filters.from || filters.to ? null : (
              <Link href={pageHref(1).replace("/transactions", "/transactions/move")} className="text-sm text-muted-foreground underline">
                Move these to a category
              </Link>
            )}
          </>
        ) : null}
      </form>
      {filters.from || filters.to ? (
        <p className="text-sm text-muted-foreground">
          Posted {filters.from ?? "any day"} to {filters.to ?? "now"}.{" "}
          <Link href={pageHref(1, {})} className="underline">
            Show all dates
          </Link>
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="text-muted-foreground">No transactions match.</p>
      ) : (
        <ul className="min-w-0 divide-y rounded-lg border">
          {visible.map((t) => (
            <li key={t.id}>
              <Link href={`/transactions/${t.id}`} className="flex min-w-0 items-start justify-between gap-3 px-3 py-2 text-sm hover:bg-accent">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.merchant ?? t.description}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t.postedOn}
                    {t.experiencedOn ? ` (for ${t.experiencedOn})` : ""} · {accountName.get(t.accountId)}
                    {t.pending ? " · pending" : ""}
                    {t.provisionalSource ? " · from an alert, not yet from the bank" : ""}
                    {t.manual ? " · added by hand" : ""}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1 text-xs">
                    {t.isSplit ? (
                      <span className="rounded bg-secondary px-1.5">Split</span>
                    ) : t.categoryId ? (
                      <span className="rounded bg-secondary px-1.5">{labelOf.get(t.categoryId)}</span>
                    ) : t.reimbursedCents >= t.amountCents && t.amountCents > 0 ? null : t.transfer ? null : t.investmentActivity ? (
                      // Investment accounts are out of budgets: an
                      // uncategorized trade isn't waiting on anything.
                      <span className="rounded bg-secondary px-1.5">{ACTIVITY_LABELS[t.investmentActivity]}</span>
                    ) : (
                      <span className="rounded bg-warning/15 px-1.5 text-warning">Uncategorized</span>
                    )}
                    {/* What it's connected to, so nothing reads as counted twice:
                        the other side of a transfer, a paycheck's pay stub. */}
                    {t.transfer ? (
                      <span className="rounded border border-dashed px-1.5 text-muted-foreground">
                        ↔ Transfer {t.amountCents > 0 ? "from" : "to"} {accountName.get(t.transfer.accountId)}
                      </span>
                    ) : t.transferUnmatched ? (
                      <span className="rounded bg-warning/15 px-1.5 text-warning">Transfer, other half not found</span>
                    ) : null}
                    {t.payStub ? (
                      <span className="rounded border border-dashed px-1.5 text-muted-foreground">
                        Pay stub {t.payStub.payDate} · {t.payStub.employer}
                      </span>
                    ) : t.paycheckWithoutStub ? (
                      <span className="rounded bg-warning/15 px-1.5 text-warning">No pay stub</span>
                    ) : null}
                    {t.sharedOwedCents ? (
                      <span className="rounded border px-1.5 text-muted-foreground">
                        Shared · your share {formatCents(-t.amountCents - t.sharedOwedCents)}
                      </span>
                    ) : null}
                    {t.reimbursedCents ? (
                      <span className="rounded border border-dashed px-1.5 text-muted-foreground">
                        Paid back {formatCents(t.reimbursedCents)}
                      </span>
                    ) : null}
                    {t.tags.map((name) => (
                      <span key={name} className="rounded border px-1.5 text-muted-foreground">
                        #{name}
                      </span>
                    ))}
                  </span>
                </span>
                <span className={`shrink-0 tabular-nums ${t.amountCents > 0 ? "text-positive" : ""}`}>
                  {formatCents(t.amountCents)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between text-sm">
        {page > 1 ? <Link href={pageHref(page - 1)} className="underline">← Newer</Link> : <span />}
        {hasMore ? <Link href={pageHref(page + 1)} className="underline">Older →</Link> : null}
      </div>
    </div>
  );
}
