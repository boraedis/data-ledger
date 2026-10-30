import Link from "next/link";
import { cashFlowInputs } from "@/lib/cashflow/data";
import { buildFlowGraph, type FlowGraph } from "@/lib/cashflow/graph";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { parsePeriod, type Grouping, type PeriodParams } from "@/lib/spending/analyze";
import { Sankey } from "./sankey";

// Cash flow (#62): a month or a year as a Sankey, gross pay to taxes and
// elections, take-home into accounts, and out to spending, savings and
// transfers. Built from the same numbers as Budgets and Spending, with the
// same groupings, so the pages agree. Display only.

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: "category", label: "Category" },
  { id: "merchant", label: "Merchant" },
  { id: "account", label: "Account" },
];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function totals(graph: FlowGraph) {
  const role = new Map(graph.nodes.map((n) => [n.id, n.role]));
  const into = (r: string) => graph.links.filter((l) => role.get(l.target) === r).reduce((s, l) => s + l.valueCents, 0);
  const outOf = (r: string) => graph.links.filter((l) => role.get(l.source) === r).reduce((s, l) => s + l.valueCents, 0);
  // Spending counted where it leaves an account, so a category and its
  // subcategories aren't added twice.
  const spent = graph.links.filter((l) => role.get(l.source) === "account" && role.get(l.target) === "spend").reduce((s, l) => s + l.valueCents, 0);
  return { income: outOf("income"), taxes: into("tax"), saved: into("saved"), deductions: graph.links.filter((l) => l.target.startsWith("deduction:")).reduce((s, l) => s + l.valueCents, 0), spent };
}

export default async function CashFlowPage(props: PageProps<"/cash-flow">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const params: PeriodParams = one(sp.year) ? { year: one(sp.year) } : { month: one(sp.month) };
  const period = parsePeriod(params, today);
  const by: Grouping = GROUPINGS.some((g) => g.id === one(sp.by)) ? (one(sp.by) as Grouping) : "category";
  const gross = one(sp.gross) === "1";

  const { paychecks, lines, transfers, lookup, uncategorized } = await cashFlowInputs(getDb(), { from: period.from, to: period.to, gross });
  const graph = buildFlowGraph({ paychecks, lines, transfers, by, lookup });
  const t = totals(graph);
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));

  const href = (next: { period?: PeriodParams; by?: Grouping; gross?: boolean }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next.period ?? params)) if (v) q.set(k, v);
    if ((next.by ?? by) !== "category") q.set("by", next.by ?? by);
    if (next.gross ?? gross) q.set("gross", "1");
    const qs = q.toString();
    return `/cash-flow${qs ? `?${qs}` : ""}`;
  };
  const thisMonth = today.slice(0, 7);
  const tab = (current: boolean) => (current ? "font-medium" : "text-muted-foreground hover:text-foreground");

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">Cash flow</h1>
          <nav aria-label="Period" className="flex items-center gap-3 text-sm">
            <Link href={href({ period: period.earlier })} className="text-muted-foreground hover:text-foreground">
              ← Earlier
            </Link>
            <span className="font-medium">{period.label}</span>
            {period.later ? (
              <Link href={href({ period: period.later })} className="text-muted-foreground hover:text-foreground">
                Later →
              </Link>
            ) : null}
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <nav aria-label="Period length" className="flex gap-3">
            <Link href={href({ period: { month: period.kind === "month" ? period.from.slice(0, 7) : thisMonth } })} aria-current={period.kind === "month" ? "page" : undefined} className={tab(period.kind === "month")}>
              Month
            </Link>
            <Link href={href({ period: { year: period.from.slice(0, 4) } })} aria-current={period.kind === "year" ? "page" : undefined} className={tab(period.kind === "year")}>
              Year
            </Link>
          </nav>
          <nav aria-label="Group spending by" className="flex gap-3">
            <span className="text-muted-foreground">Spending by</span>
            {GROUPINGS.map((g) => (
              <Link
                key={g.id}
                href={href({ by: g.id })}
                aria-current={g.id === by ? "page" : undefined}
                className={`-mb-px border-b-2 ${g.id === by ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {g.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        {[
          ["Income", t.income, "var(--flow-income)"],
          ["Taxes", t.taxes, "var(--muted-foreground)"],
          ["Saved and invested", t.saved, "var(--flow-saved)"],
          ["Other deductions", t.deductions, "var(--flow-spend)"],
          ["Spent", t.spent, "var(--flow-spend)"],
        ].map(([name, cents, color]) =>
          cents || name === "Income" || name === "Spent" ? (
            <div key={name as string} className="rounded-lg border p-3">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ background: color as string }} aria-hidden />
                {name}
              </dt>
              <dd className="tabular-nums">{formatCents(cents as number)}</dd>
            </div>
          ) : null,
        )}
      </dl>

      <p className="text-sm text-muted-foreground">
        Pay runs gross to net through taxes and elections into the accounts it was deposited to; money then leaves each account as spending
        (net, the same as Budgets) or moves to another account. Transfers between your accounts are never income or spending. Only paychecks with a
        linked pay stub show their taxes and deductions; others count as the deposit.{" "}
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
          {uncategorized.count} uncategorized transaction{uncategorized.count === 1 ? "" : "s"} ({formatCents(uncategorized.cents)} out) aren&apos;t in
          the diagram.{" "}
          <Link href="/inbox" className="underline">
            File them in Inbox
          </Link>
        </p>
      ) : null}

      {graph.links.length === 0 ? (
        <p className="text-muted-foreground">Nothing categorized in {period.label} yet.</p>
      ) : (
        <>
          <Sankey graph={graph} label={`Cash flow for ${period.label}`} />
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Every flow as a table</summary>
            <table className="mt-2 w-full">
              <caption className="sr-only">Cash flow for {period.label}: each flow, its amount and the transactions behind it</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="pb-1 font-normal">
                    From
                  </th>
                  <th scope="col" className="pb-1 font-normal">
                    To
                  </th>
                  <th scope="col" className="pb-1 text-right font-normal">
                    Amount
                  </th>
                  <th scope="col" className="pb-1 text-right font-normal">
                    Transactions
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...graph.links]
                  .sort((a, b) => b.valueCents - a.valueCents)
                  .map((l) => (
                    <tr key={`${l.source}→${l.target}`} className="border-t">
                      <td className="py-1 pr-2">{label.get(l.source)}</td>
                      <td className="py-1 pr-2">{label.get(l.target)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{formatCents(l.valueCents)}</td>
                      <td className="py-1 text-right tabular-nums">{l.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
