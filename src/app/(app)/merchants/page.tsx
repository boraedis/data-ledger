import Link from "next/link";
import { getDb } from "@/lib/db";
import { filterMerchants, SORTS, type Sort } from "@/lib/merchants/overview";
import { formatCents } from "@/lib/money";
import { merchantOverviewRead, mergeSuggestions, suggestionEvidence } from "@/operations/merchant-views";
import { listMerchantTypes } from "@/operations/merchants";
import { read } from "@/operations/runtime";
import { MergeSuggestions } from "./suggestions";

// Merchants (#286): every merchant, with what it's cost over all history,
// how often and how lately it's been seen, its usual category, whether it
// recurs and its type (#285). Search, type filter and sort are in the URL,
// so a view can be linked to and the page works without JavaScript, as on
// Spending. A merchant opens its own page, where it's renamed, typed and
// merged. Net spend by default, the lines Spending and Budgets count.
// Above the list, merchants that are probably one business (#287), for the
// owner to merge or reject.

const SUGGESTIONS = 10;

const SORT_LABELS: Record<Sort, string> = { spent: "Spent", transactions: "Transactions", last: "Last seen", name: "Name" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const day = (on: string) => new Date(`${on}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function MerchantsPage(props: PageProps<"/merchants">) {
  const sp = await props.searchParams;
  const q = one(sp.q) ?? "";
  const type = one(sp.type) || null;
  const sort: Sort = (SORTS as readonly string[]).includes(one(sp.sort) ?? "") ? (one(sp.sort) as Sort) : "spent";
  const gross = one(sp.gross) === "1";

  const db = getDb();
  const [rows, types, pairs] = await Promise.all([read(db, merchantOverviewRead, { gross }), read(db, listMerchantTypes, {}), read(db, mergeSuggestions, {})]);
  const shownPairs = pairs.slice(0, SUGGESTIONS);
  const evidence = await suggestionEvidence(db, [...new Set(shownPairs.flatMap((p) => [p.a.id, p.b.id]))]);
  const withEvidence = (side: (typeof pairs)[number]["a"]) => ({ ...side, transactions: 0, amountCents: 0, accounts: [], lastOn: null, ...evidence.get(side.id) });
  const shown = filterMerchants(rows, { q, type, sort });

  const href = (next: { sort?: Sort; gross?: boolean }) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (type) p.set("type", type);
    const s = next.sort ?? sort;
    if (s !== "spent") p.set("sort", s);
    if (next.gross ?? gross) p.set("gross", "1");
    const qs = p.toString();
    return `/merchants${qs ? `?${qs}` : ""}`;
  };
  const withGross = (path: string) => (gross ? `${path}?gross=1` : path);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Merchants</h1>
        <p className="text-sm text-muted-foreground">
          Every merchant, however the bank spells it: each one&apos;s spellings are its names. Spent is over all history, net of what friends
          owe, the same as Spending.{" "}
          <Link href={href({ gross: !gross })} className="underline">
            {gross ? "Show your share" : "Show gross"}
          </Link>{" "}
          ·{" "}
          <Link href="/merchants/cleanup" className="underline">
            Clean up names
          </Link>
        </p>
      </div>

      {shownPairs.length ? (
        <MergeSuggestions suggestions={shownPairs.map((p) => ({ reason: p.reason, a: withEvidence(p.a), b: withEvidence(p.b) }))} total={pairs.length} />
      ) : null}

      {/* A plain GET form: the search goes in the URL like everything else. */}
      <form action="/merchants" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex min-w-0 basis-full flex-col text-xs text-muted-foreground sm:basis-auto">
          Search
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name or spelling"
            className="h-9 min-w-0 rounded border bg-background px-2 text-sm text-foreground sm:w-64"
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          Type
          <select name="type" defaultValue={type ?? ""} className="h-9 rounded border bg-background px-2 text-sm text-foreground">
            <option value="">Any type</option>
            <option value="none">No type yet</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {sort !== "spent" ? <input type="hidden" name="sort" value={sort} /> : null}
        {gross ? <input type="hidden" name="gross" value="1" /> : null}
        <button type="submit" className="h-9 rounded border px-3 hover:bg-muted">
          Show
        </button>
      </form>

      <nav aria-label="Sort by" className="flex flex-wrap gap-3 text-sm">
        <span className="text-muted-foreground">Sort by</span>
        {SORTS.map((s) => (
          <Link
            key={s}
            href={href({ sort: s })}
            aria-current={s === sort ? "page" : undefined}
            className={`-mb-px border-b-2 ${s === sort ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {SORT_LABELS[s]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No merchants yet: they appear as transactions come in.</p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground">No merchant matches that.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">
            {shown.length} merchants, sorted by {SORT_LABELS[sort].toLowerCase()}
          </caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-1 text-left font-normal">
                Merchant
              </th>
              <th scope="col" className="hidden w-28 pb-1 text-left font-normal md:table-cell">
                Type
              </th>
              <th scope="col" className="hidden w-32 pb-1 text-left font-normal md:table-cell">
                Usual category
              </th>
              <th scope="col" className="w-24 pb-1 text-right font-normal sm:w-28">
                Spent
              </th>
              <th scope="col" className="hidden w-16 pb-1 text-right font-normal sm:table-cell">
                Count
              </th>
              <th scope="col" className="hidden w-28 pb-1 text-right font-normal sm:table-cell">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className="border-t align-top">
                <td className="py-2 pr-2">
                  <Link href={withGross(`/merchants/${m.id}`)} className="block truncate font-medium underline-offset-2 hover:underline">
                    {m.name}
                  </Link>
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span className="md:hidden">{m.type ?? "No type"}</span>
                    {m.aliases.length > 1 ? <span>{m.aliases.length} spellings</span> : null}
                    {m.recurs ? <span className="rounded-sm border px-1">recurring</span> : null}
                    {/* What the hidden columns hold, on a phone. */}
                    <span className="sm:hidden">
                      {m.transactions} · {m.lastSeen ? day(m.lastSeen) : "never"}
                    </span>
                  </span>
                </td>
                <td className="hidden truncate py-2 pr-2 text-muted-foreground md:table-cell">{m.type ?? "—"}</td>
                <td className="hidden truncate py-2 pr-2 text-muted-foreground md:table-cell">{m.usualCategory?.name ?? "—"}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatCents(m.spentCents)}</td>
                <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">{m.transactions}</td>
                <td className="hidden py-2 text-right tabular-nums text-muted-foreground sm:table-cell">{m.lastSeen ? day(m.lastSeen) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
