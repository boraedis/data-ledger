import { inArray } from "drizzle-orm";
import Link from "next/link";
import { transactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import {
  findRow,
  parsePeriod,
  rowTransactions,
  spendingRows,
  type Grouping,
  type Lookup,
  type PeriodParams,
  type Row,
} from "@/lib/spending/analyze";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { misfiledTransfers, spendingLines, uncategorizedSpend } from "@/operations/transactions";
import { MisfiledTransfers } from "../cash-flow/misfiled-transfers";

// Spending (#66): where the money went over a period, by category, merchant
// or account, each against the period before. The lines are
// transactions.spendingLines, the ones Budgets counts, so the two agree.
// Everything is in the URL (period, grouping, selection, what's expanded),
// so any view can be linked to and the page works without JavaScript.
// Account rows show names only: never balances or account numbers.

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: "category", label: "Category" },
  { id: "merchant", label: "Merchant" },
  { id: "account", label: "Account" },
];

// A year of merchants is a long list; the rest are summed in one line.
const MAX_ROWS = 40;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fmtDay = (on: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${on}T00:00:00Z`));

function Change({ spent, prev }: { spent: number; prev: number }) {
  const diff = spent - prev;
  if (prev === 0 && spent === 0) return <span className="text-muted-foreground">—</span>;
  if (prev === 0) return <span className="text-muted-foreground">new</span>;
  if (diff === 0) return <span className="text-muted-foreground">same</span>;
  // More spending reads as the warning direction.
  return (
    <span className={diff > 0 ? "text-negative" : "text-positive"}>
      {diff > 0 ? "+" : "−"}
      {formatCents(Math.abs(diff))}
      <span className="hidden text-xs sm:inline"> ({Math.round((Math.abs(diff) / prev) * 100)}%)</span>
    </span>
  );
}

export default async function SpendingPage(props: PageProps<"/spending">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const params: PeriodParams = { month: one(sp.month), year: one(sp.year), from: one(sp.from), to: one(sp.to) };
  const period = parsePeriod(params, today);
  const by: Grouping = GROUPINGS.some((g) => g.id === one(sp.by)) ? (one(sp.by) as Grouping) : "category";
  const gross = one(sp.gross) === "1";
  const selected = one(sp.sel) ?? null;
  const open = new Set((one(sp.open) ?? "").split(",").filter(Boolean));

  const db = getDb();
  const [lines, prevLines, cats, accts, uncategorized, misfiled] = await Promise.all([
    read(db, spendingLines, { from: period.from, to: period.to, budgetOnly: true, gross }),
    read(db, spendingLines, { from: period.prev.from, to: period.prev.to, budgetOnly: true, gross }),
    read(db, listCategories, {}),
    read(db, listAccounts, {}),
    read(db, uncategorizedSpend, { from: period.from, to: period.to }),
    read(db, misfiledTransfers, { from: period.from, to: period.to }),
  ]);
  const lookup: Lookup = {
    categories: new Map(cats.map((c) => [c.id, c])),
    accountNames: new Map(accts.map((a) => [a.id, a.name])),
  };
  const { rows, totalCents, prevTotalCents } = spendingRows(lines, prevLines, by, lookup);
  const shown = rows.slice(0, MAX_ROWS);
  const rest = rows.slice(MAX_ROWS);

  // The transactions behind the selected row, with their descriptions.
  const selectedRow = selected !== null ? findRow(rows, selected) : undefined;
  const behind = selectedRow ? rowTransactions(lines, selectedRow.key, by, lookup) : [];
  const descriptions = behind.length
    ? new Map(
        (await db.select({ id: transactions.id, description: transactions.description }).from(transactions).where(inArray(transactions.id, behind.map((t) => t.transactionId)))).map(
          (t) => [t.id, t.description],
        ),
      )
    : new Map<string, string>();

  const href = (next: { period?: PeriodParams; by?: Grouping; gross?: boolean; sel?: string | null; open?: Set<string> }, hash = "") => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next.period ?? params)) if (v) q.set(k, v);
    const g = next.by ?? by;
    if (g !== "category") q.set("by", g);
    if (next.gross ?? gross) q.set("gross", "1");
    const s = next.sel === undefined ? selected : next.sel;
    if (s !== null) q.set("sel", s);
    const o = next.open ?? open;
    if (o.size && g === "category") q.set("open", [...o].join(","));
    const qs = q.toString();
    return `/spending${qs ? `?${qs}` : ""}${hash}`;
  };
  const toggled = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const thisMonth = today.slice(0, 7);

  const RowLine = ({ row, depth, parent }: { row: Row; depth: number; parent?: Row }) => {
    const share = totalCents > 0 ? Math.max(0, row.spentCents) / totalCents : 0;
    const expandable = row.children.length > 0;
    const isOpen = open.has(row.key);
    return (
      <tr className={`border-t ${row.key === selected ? "bg-primary/10" : ""}`}>
        <td className={`py-2 pr-2 ${depth ? "pl-6" : ""}`}>
          <div className="flex items-center gap-1">
            {expandable ? (
              <Link
                href={href({ open: toggled(row.key) })}
                scroll={false}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Hide" : "Show"} subcategories of ${row.label}`}
                className="w-4 shrink-0 text-muted-foreground hover:text-foreground"
              >
                {isOpen ? "▾" : "▸"}
              </Link>
            ) : depth === 0 && by === "category" ? (
              <span className="w-4 shrink-0" />
            ) : null}
            <Link href={href({ sel: row.key }, "#behind")} className="min-w-0 truncate underline-offset-2 hover:underline" title={parent ? `${parent.label}: ${row.label}` : row.label}>
              {row.label}
            </Link>
          </div>
          <div className={`mt-1 flex items-center gap-2 ${expandable || (depth === 0 && by === "category") ? "pl-5" : ""}`}>
            <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">{Math.round(share * 100)}%</span>
          </div>
        </td>
        <td className="py-2 pr-2 text-right align-top tabular-nums">{formatCents(row.spentCents)}</td>
        <td className="py-2 text-right align-top text-sm tabular-nums">
          <Change spent={row.spentCents} prev={row.prevCents} />
        </td>
      </tr>
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">Spending</h1>
          <nav aria-label="Period" className="flex items-center gap-3 text-sm">
            <Link href={href({ period: period.earlier, sel: null })} className="text-muted-foreground hover:text-foreground">
              ← Earlier
            </Link>
            <span className="font-medium">{period.label}</span>
            {period.later ? (
              <Link href={href({ period: period.later, sel: null })} className="text-muted-foreground hover:text-foreground">
                Later →
              </Link>
            ) : null}
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <nav aria-label="Period length" className="flex gap-3">
            <Link
              href={href({ period: { month: period.kind === "month" ? period.from.slice(0, 7) : thisMonth }, sel: null })}
              aria-current={period.kind === "month" ? "page" : undefined}
              className={period.kind === "month" ? "font-medium" : "text-muted-foreground hover:text-foreground"}
            >
              Month
            </Link>
            <Link
              href={href({ period: { year: period.from.slice(0, 4) }, sel: null })}
              aria-current={period.kind === "year" ? "page" : undefined}
              className={period.kind === "year" ? "font-medium" : "text-muted-foreground hover:text-foreground"}
            >
              Year
            </Link>
            <details className="group" open={period.kind === "range"}>
              <summary className={`cursor-pointer list-none ${period.kind === "range" ? "font-medium" : "text-muted-foreground hover:text-foreground"}`}>Custom</summary>
              {/* A plain GET form: the range goes in the URL like everything else. */}
              <form action="/spending" className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-xs text-muted-foreground">
                  From
                  <input type="date" name="from" required max={today} defaultValue={period.from} className="rounded border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col text-xs text-muted-foreground">
                  To
                  <input type="date" name="to" required defaultValue={period.to} className="rounded border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                {by !== "category" ? <input type="hidden" name="by" value={by} /> : null}
                {gross ? <input type="hidden" name="gross" value="1" /> : null}
                <button type="submit" className="rounded border px-2 py-1 text-sm hover:bg-muted">
                  Show
                </button>
              </form>
            </details>
          </nav>
          <nav aria-label="Group by" className="flex gap-3">
            <span className="text-muted-foreground">By</span>
            {GROUPINGS.map((g) => (
              <Link
                key={g.id}
                href={href({ by: g.id, sel: null, open: new Set() })}
                aria-current={g.id === by ? "page" : undefined}
                className={`-mb-px border-b-2 ${g.id === by ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {g.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <section className="space-y-1">
        <p className="text-3xl font-semibold tabular-nums">{formatCents(totalCents)}</p>
        <p className="text-sm text-muted-foreground">
          spent in {period.label} · <Change spent={totalCents} prev={prevTotalCents} /> vs {period.prev.label} ({formatCents(prevTotalCents)})
        </p>
        <p className="text-sm text-muted-foreground">
          Net spending in accounts that count toward budgets, the same as Budgets: refunds offset it, and transfers,
          income and reimbursements never count.{" "}
          {gross ? (
            <>
              Showing <strong>gross</strong> spending, before friends&apos; shares come off.{" "}
              <Link href={href({ gross: false })} className="underline">
                Show your share
              </Link>
            </>
          ) : (
            <>
              Shared expenses count only your share.{" "}
              <Link href={href({ gross: true })} className="underline">
                Show gross
              </Link>
            </>
          )}
        </p>
        {uncategorized.count ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            Plus {formatCents(uncategorized.cents)} in {uncategorized.count} uncategorized transaction{uncategorized.count === 1 ? "" : "s"}, not counted above.{" "}
            <Link href="/inbox" className="underline">
              File them in Inbox
            </Link>
          </p>
        ) : null}
        <MisfiledTransfers pairs={misfiled} />
      </section>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No spending in {period.label}.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">
            Spending by {by} in {period.label}, with each one&apos;s share of the total and the change against {period.prev.label}.
          </caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-1 text-left font-normal">
                {GROUPINGS.find((g) => g.id === by)!.label}
              </th>
              <th scope="col" className="w-24 pb-1 text-right font-normal sm:w-28">
                Spent
              </th>
              <th scope="col" className="w-24 pb-1 text-right font-normal sm:w-36">
                vs {period.prev.label}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((row) => [
              <RowLine key={row.key} row={row} depth={0} />,
              ...(open.has(row.key) ? row.children.map((child) => <RowLine key={child.key} row={child} depth={1} parent={row} />) : []),
            ])}
            {rest.length ? (
              <tr className="border-t text-muted-foreground">
                <td className="py-2 pr-2">
                  {rest.length} more {by === "merchant" ? "merchants" : by === "account" ? "accounts" : "categories"}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatCents(rest.reduce((s, r) => s + r.spentCents, 0))}</td>
                <td />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {selectedRow ? (
        <section id="behind" className="scroll-mt-4 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-medium">
              {selectedRow.label} · {period.label}
            </h2>
            <Link href={href({ sel: null })} scroll={false} className="text-sm text-muted-foreground hover:text-foreground">
              Close
            </Link>
          </div>
          {behind.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in {period.label}; the figure compared is from {period.prev.label}.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {behind.map((t) => (
                <li key={t.transactionId}>
                  <Link href={`/transactions/${t.transactionId}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block truncate">{t.merchant ?? descriptions.get(t.transactionId) ?? "Transaction"}</span>
                      <span className="block text-xs text-muted-foreground">
                        {fmtDay(t.date)} · {lookup.accountNames.get(t.accountId) ?? ""}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatCents(t.spentCents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
