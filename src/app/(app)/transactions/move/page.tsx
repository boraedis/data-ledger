import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { MAX_MOVE, moveToCategoryPreview } from "@/operations/recategorize";
import { read } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { MovePreview } from "./move-preview";

// Move many transactions to one category (#116): the Transactions list's
// filter (same query parameters) picks the rows, ?to= the category, and the
// preview is where single rows are ticked in or out. Nothing changes until
// Apply.

const select = "h-9 rounded-md border bg-background px-2 text-sm";

function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : undefined;
}

export default async function MovePage(props: PageProps<"/transactions/move">) {
  const sp = await props.searchParams;
  const filter = { search: param(sp.q), categoryId: param(sp.category), tagId: param(sp.tag), accountId: param(sp.account) };
  const to = param(sp.to);
  const db = getDb();
  const [cats, tagList, accts] = await Promise.all([read(db, listCategories, {}), read(db, listTags, {}), read(db, listAccounts, {})]);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));
  const hasFilter = Object.values(filter).some(Boolean);

  const listHref = (() => {
    const q = new URLSearchParams();
    if (filter.search) q.set("q", filter.search);
    if (filter.categoryId) q.set("category", filter.categoryId);
    if (filter.tagId) q.set("tag", filter.tagId);
    if (filter.accountId) q.set("account", filter.accountId);
    const s = q.toString();
    return s ? `/transactions?${s}` : "/transactions";
  })();
  // In words, so it's clear which rows "everything matching" means.
  const described = [
    filter.search ? `matching “${filter.search}”` : null,
    filter.categoryId ? `in ${labelOf.get(filter.categoryId) ?? "a category"}` : null,
    filter.tagId ? `tagged #${tagList.find((t) => t.id === filter.tagId)?.name ?? "?"}` : null,
    filter.accountId ? `in ${accts.find((a) => a.id === filter.accountId)?.name ?? "an account"}` : null,
  ].filter(Boolean);

  const preview = hasFilter && to && labelOf.has(to) ? await read(db, moveToCategoryPreview, { categoryId: to, filter }) : null;

  return (
    <div className="space-y-4">
      <Link href={listHref} className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to the list
      </Link>
      <h1 className="text-2xl font-semibold">Move transactions to a category</h1>
      {!hasFilter ? (
        <p className="text-sm text-muted-foreground">
          Filter the <Link href="/transactions" className="underline">transactions list</Link> first (a search, a category, a tag or an account), then
          choose &ldquo;Move these to a category&rdquo;.
        </p>
      ) : (
        <>
          <p className="text-sm">Transactions {described.join(", ")}.</p>
          <form className="flex flex-wrap items-center gap-2" action="/transactions/move">
            {filter.search ? <input type="hidden" name="q" value={filter.search} /> : null}
            {filter.categoryId ? <input type="hidden" name="category" value={filter.categoryId} /> : null}
            {filter.tagId ? <input type="hidden" name="tag" value={filter.tagId} /> : null}
            {filter.accountId ? <input type="hidden" name="account" value={filter.accountId} /> : null}
            <select name="to" defaultValue={to ?? ""} aria-label="Move to" className={select} required>
              <option value="">Move to…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-accent">
              Preview
            </button>
          </form>
          {preview ? (
            <div className="space-y-3">
              {preview.truncated ? (
                <p className="text-sm text-warning">More than {MAX_MOVE} match. This moves the newest {MAX_MOVE}; run it again for the rest.</p>
              ) : null}
              {preview.alreadyThere || preview.pairedTransfers ? (
                <p className="text-xs text-muted-foreground">
                  {[
                    preview.alreadyThere ? `${preview.alreadyThere} already in ${preview.categoryName}` : null,
                    preview.pairedTransfers
                      ? `${preview.pairedTransfers} ${preview.pairedTransfers === 1 ? "is one side" : "are sides"} of a transfer (unpair on the transaction instead)`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("; ")}
                  , left as they are.
                </p>
              ) : null}
              {preview.changes.length ? (
                <MovePreview categoryId={to!} categoryName={preview.categoryName} changes={preview.changes} names={Object.fromEntries(labelOf)} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing to move: they&apos;re all in {preview.categoryName} already.</p>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
