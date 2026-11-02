import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { manualMatches } from "@/operations/manual";
import { listTransactions, transactionTypeCounts } from "@/operations/transactions";
import { categoryBadge } from "./category-badge";
import { SubmitOnChange } from "./submit-on-change";
import { MORE_FILTERS, SOURCE_LABELS, TYPES, datePresets, dollars, parseView, viewHref } from "./view";

const PAGE_SIZE = 100;
const select = "h-9 rounded-md border bg-background px-2 text-sm";

// Every transaction, filterable. The filter is a plain GET form: no client
// JavaScript, and every filtered view is a shareable, back-button-friendly
// URL. Rows open the detail page, where splitting and tagging happen.
// ?type= picks one kind of row (#208): transfers with no other half (#184),
// uncategorized, connected to a pay stub, or flagged (#210). The More
// filters panel (#211) holds the rest: dates (?from= and ?to=, as the Cash
// flow page links to its own period), amounts, transfers with one account,
// and what a row has or where it came from. view.ts reads and writes them.
export default async function TransactionsPage(props: PageProps<"/transactions">) {
  const sp = await props.searchParams;
  const view = parseView(sp);
  const { filters, type } = view;
  const page = Math.max(Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1, 1);
  const moreActive = MORE_FILTERS.filter((key) => filters[key] !== undefined).length;
  // from and to are one filter to a person: a date range.
  const moreCount = moreActive - (filters.from !== undefined && filters.to !== undefined ? 1 : 0);
  const anyFilter = type !== undefined || Object.values(filters).some((v) => v !== undefined);

  const db = getDb();
  const [rows, cats, tagList, accts, toMerge, counts] = await Promise.all([
    read(db, listTransactions, { ...filters, ...(type ? { [TYPES[type].filter]: true } : {}), limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    read(db, listCategories, {}),
    read(db, listTags, {}),
    read(db, listAccounts, {}),
    read(db, manualMatches, {}),
    // Under the other filters, so an option's count is the rows it lists.
    read(db, transactionTypeCounts, filters),
  ]);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));
  const accountName = new Map(accts.map((a) => [a.id, a.name]));

  const today = new Date().toISOString().slice(0, 10);

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
          placeholder="Search merchant, date or amount"
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
        <select name="type" defaultValue={type ?? ""} aria-label="Type" className={select}>
          <option value="">All types</option>
          {Object.entries(TYPES).map(([key, t]) => (
            <option key={key} value={key}>
              {t.label} ({counts[t.filter]})
            </option>
          ))}
        </select>
        {/* Applies a dropdown or checkbox as soon as it changes (#207); the
            button is for typed fields, and for when scripts are off. */}
        <SubmitOnChange />
        <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-accent">
          Filter
        </button>
        {anyFilter ? (
          <>
            <Link href="/transactions" className="text-sm text-muted-foreground underline">
              Clear
            </Link>
            {/* Everything this filter shows, filed somewhere else at once (#116). The move page reads the
                category, tag, account and search only, so with a type or anything from More filters it would
                move more than is shown; those views leave the link out. */}
            {type || moreActive ? null : (
              <Link href={viewHref(view, {}, "/transactions/move")} className="text-sm text-muted-foreground underline">
                Move these to a category
              </Link>
            )}
          </>
        ) : null}
        {/* The rest of the filters (#211), in the same GET form so they
            combine with the bar's and land in the URL. A <details>, so it
            opens without scripts; it starts open while any of it applies,
            so a filter in effect is never hidden. */}
        <details className="w-full rounded-lg border px-3 py-2 text-sm" open={moreActive > 0}>
          <summary className="cursor-pointer select-none">More filters{moreCount ? ` (${moreCount})` : ""}</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <fieldset className="space-y-2">
              <legend className="font-medium">Posted</legend>
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" name="from" defaultValue={filters.from} aria-label="From" className={select} />
                <span className="text-muted-foreground">to</span>
                <input type="date" name="to" defaultValue={filters.to} aria-label="To" className={select} />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {datePresets(today).map((p) => (
                  <Link key={p.label} href={viewHref(view, { from: p.from, to: p.to })} className="text-muted-foreground underline">
                    {p.label}
                  </Link>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="font-medium">Amount</legend>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  name="min"
                  inputMode="decimal"
                  defaultValue={filters.amountMinCents === undefined ? undefined : dollars(filters.amountMinCents)}
                  placeholder="Min"
                  aria-label="Minimum amount"
                  className={`${select} w-24`}
                />
                <span className="text-muted-foreground">to</span>
                <input
                  name="max"
                  inputMode="decimal"
                  defaultValue={filters.amountMaxCents === undefined ? undefined : dollars(filters.amountMaxCents)}
                  placeholder="Max"
                  aria-label="Maximum amount"
                  className={`${select} w-24`}
                />
              </div>
              {/* Off, the range is on the amount's size: $10 to $50 finds
                  charges and refunds alike. On, money out is negative, as
                  the list shows it, so -50 to -10 is charges only. */}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="signed" value="1" defaultChecked={filters.amountSigned} />
                Signed: money out is negative
              </label>
            </fieldset>
            <label className="space-y-2">
              <span className="block font-medium">Transfers with</span>
              <select name="xfer" defaultValue={filters.transferAccountId ?? ""} className={select}>
                <option value="">Any account</option>
                {accts.filter((a) => !a.manual).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2">
              <span className="block font-medium">Source</span>
              <select name="source" defaultValue={filters.source ?? ""} className={select}>
                <option value="">Any source</option>
                {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2 sm:col-span-2">
              <legend className="mb-2 font-medium">Has</legend>
              {(
                [
                  ["stub", "A pay stub", filters.payStubLinked],
                  ["tags", "Tags", filters.hasTags],
                  ["split", "A split", filters.split],
                  ["pending", "Pending", filters.pending],
                ] as const
              ).map(([name, label, checked]) => (
                <label key={name} className="flex items-center gap-2">
                  <input type="checkbox" name={name} value="1" defaultChecked={checked} />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
        </details>
      </form>

      {visible.length === 0 ? (
        <p className="text-muted-foreground">No transactions match.</p>
      ) : (
        <ul className="min-w-0 divide-y rounded-lg border">
          {visible.map((t) => (
            <li key={t.id}>
              {/* A pending row is greyed (#212): it can still change or vanish
                  before it posts, when its posted version replaces it. */}
              <Link
                href={`/transactions/${t.id}`}
                className={`flex min-w-0 items-start justify-between gap-3 px-3 py-2 text-sm hover:bg-accent ${t.pending ? "text-muted-foreground" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.merchant ?? t.description}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t.postedOn}
                    {t.experiencedOn ? ` (for ${t.experiencedOn})` : ""} · {accountName.get(t.accountId)}
                    {t.provisionalSource ? " · from an alert, not yet from the bank" : ""}
                    {t.manual ? " · added by hand" : ""}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1 text-xs">
                    {t.pending ? <span className="rounded border border-dashed px-1.5">Pending</span> : null}
                    {/* A suspicious-charge flag (#210), until it's called fine. */}
                    {t.flagged ? <span className="rounded bg-destructive/15 px-1.5 text-destructive">Flagged</span> : null}
                    <Badge badge={categoryBadge(t, (id) => labelOf.get(id))} />
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
                <span className={`shrink-0 tabular-nums ${t.amountCents > 0 && !t.pending ? "text-positive" : ""}`}>
                  {formatCents(t.amountCents)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between text-sm">
        {page > 1 ? <Link href={viewHref(view, { page: page - 1 })} className="underline">← Newer</Link> : <span />}
        {hasMore ? <Link href={viewHref(view, { page: page + 1 })} className="underline">Older →</Link> : null}
      </div>
    </div>
  );
}

function Badge({ badge }: { badge: ReturnType<typeof categoryBadge> }) {
  if (!badge) return null;
  switch (badge.kind) {
    case "split":
      return <span className="rounded bg-secondary px-1.5">Split</span>;
    case "category":
    case "activity":
      return <span className="rounded bg-secondary px-1.5">{badge.label}</span>;
    case "uncategorized":
      // Investment accounts are out of budgets: an uncategorized trade
      // isn't waiting on anything, so it isn't a warning.
      return badge.waiting ? (
        <span className="rounded bg-warning/15 px-1.5 text-warning">Uncategorized</span>
      ) : (
        <span className="rounded bg-secondary px-1.5">Uncategorized</span>
      );
  }
}
