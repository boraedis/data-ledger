import Link from "next/link";
import { cashFlowInputs } from "@/lib/cashflow/data";
import { buildFlowGraph, type FlowGraph } from "@/lib/cashflow/graph";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { parsePeriod, type PeriodParams } from "@/lib/spending/analyze";
import { Sankey } from "./sankey";

// Cash flow (#62): a month or a year as a Sankey in five levels: where the
// money came from; take-home and what came off the paycheck first; where it
// went (spending, investing, cash savings, debt); the breakdown; and
// subcategories. Built from the same numbers as Budgets and Spending, so
// the pages agree. Display only.

type Grouping = "category" | "merchant";
const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: "category", label: "Category" },
  { id: "merchant", label: "Merchant" },
];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function totals(graph: FlowGraph) {
  const role = new Map(graph.nodes.map((n) => [n.id, n.role]));
  const sum = (pick: (l: FlowGraph["links"][number]) => boolean) => graph.links.filter(pick).reduce((s, l) => s + l.valueCents, 0);
  return {
    income: sum((l) => role.get(l.source) === "income"),
    drawn: sum((l) => role.get(l.source) === "draw"),
    taxes: sum((l) => role.get(l.target) === "tax"),
    spent: sum((l) => l.target === "bucket:spending"),
    invested: sum((l) => l.target === "bucket:investing"),
    saved: sum((l) => l.target === "bucket:savings"),
    debt: sum((l) => l.target === "bucket:debt" || l.target === "bucket:other"),
  };
}

export default async function CashFlowPage(props: PageProps<"/cash-flow">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const params: PeriodParams = one(sp.year) ? { year: one(sp.year) } : { month: one(sp.month) };
  const period = parsePeriod(params, today);
  const by: Grouping = GROUPINGS.some((g) => g.id === one(sp.by)) ? (one(sp.by) as Grouping) : "category";
  const gross = one(sp.gross) === "1";

  const { paychecks, lines, transfers, uncategorized, accounts, lookup, uncategorizedOut } = await cashFlowInputs(getDb(), { from: period.from, to: period.to, gross });
  const graph = buildFlowGraph({ paychecks, lines, uncategorized, transfers, accounts, by, lookup });
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
          <nav aria-label="Break spending down by" className="flex gap-3">
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

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {[
          ["Income", t.income, "var(--flow-income)"],
          ["Drawn on", t.drawn, "var(--muted-foreground)"],
          ["Taxes", t.taxes, "var(--muted-foreground)"],
          ["Spent", t.spent, "var(--flow-spend)"],
          ["Invested", t.invested, "var(--flow-saved)"],
          ["Cash saved", t.saved, "var(--flow-saved)"],
          ["Debt paid down", t.debt, "var(--muted-foreground)"],
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
        Left to right: where the money came from (including what you drew on: savings, cards, cash on hand); take-home and what came off your pay
        first; where it went; and the breakdown. Spending is net, the same as Budgets, and charged to a card counts when charged. Moving money
        between your accounts is never income or spending: it shows as saved, invested, paid down or drawn on, net for the period. Only paychecks
        with a linked pay stub show their taxes and deductions; others count as the deposit.{" "}
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
      {uncategorizedOut.count ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {formatCents(uncategorizedOut.cents)} of spending is uncategorized ({uncategorizedOut.count} transaction{uncategorizedOut.count === 1 ? "" : "s"}), shown as
          &quot;Uncategorized&quot;.{" "}
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
