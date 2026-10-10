import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { listTransactions } from "@/operations/transactions";

const PAGE_SIZE = 100;
const select = "h-9 rounded-md border bg-background px-2 text-sm";

function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : undefined;
}

// Every transaction, filterable. The filter is a plain GET form: no client
// JavaScript, and every filtered view is a shareable, back-button-friendly
// URL. Rows open the detail page, where splitting and tagging happen.
export default async function TransactionsPage(props: PageProps<"/transactions">) {
  const sp = await props.searchParams;
  const filters = {
    search: param(sp.q),
    categoryId: param(sp.category),
    tagId: param(sp.tag),
    accountId: param(sp.account),
  };
  const page = Math.max(Number(param(sp.page) ?? 1) || 1, 1);

  const db = getDb();
  const [rows, cats, tagList, accts] = await Promise.all([
    read(db, listTransactions, { ...filters, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    read(db, listCategories, {}),
    read(db, listTags, {}),
    read(db, listAccounts, {}),
  ]);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));
  const accountName = new Map(accts.map((a) => [a.id, a.name]));

  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (filters.search) q.set("q", filters.search);
    if (filters.categoryId) q.set("category", filters.categoryId);
    if (filters.tagId) q.set("tag", filters.tagId);
    if (filters.accountId) q.set("account", filters.accountId);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/transactions?${s}` : "/transactions";
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Transactions</h1>
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
        <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-accent">
          Filter
        </button>
        {Object.values(filters).some(Boolean) ? (
          <Link href="/transactions" className="text-sm text-muted-foreground underline">
            Clear
          </Link>
        ) : null}
      </form>

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
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1 text-xs">
                    {t.isSplit ? (
                      <span className="rounded bg-secondary px-1.5">Split</span>
                    ) : t.categoryId ? (
                      <span className="rounded bg-secondary px-1.5">{labelOf.get(t.categoryId)}</span>
                    ) : (
                      <span className="rounded bg-amber-500/15 px-1.5 text-amber-800 dark:text-amber-200">Uncategorized</span>
                    )}
                    {t.tags.map((name) => (
                      <span key={name} className="rounded border px-1.5 text-muted-foreground">
                        #{name}
                      </span>
                    ))}
                  </span>
                </span>
                <span className={`shrink-0 tabular-nums ${t.amountCents > 0 ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
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
