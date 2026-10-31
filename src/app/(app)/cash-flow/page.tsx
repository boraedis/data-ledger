import Link from "next/link";
import { cashFlowInputs } from "@/lib/cashflow/data";
import { formatShare } from "@/lib/cashflow/format";
import { buildFlowGraph, type FlowGraph } from "@/lib/cashflow/graph";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { parseView, step, switchTo, viewQuery, VIEWS, type CashFlowView, type ViewPeriod } from "@/lib/cashflow/view";
import { cashFlowSeries } from "@/operations/cashflow";
import { read } from "@/operations/runtime";
import { misfiledTransfers } from "@/operations/transactions";
import { MisfiledTransfers } from "./misfiled-transfers";
import { Sankey } from "./sankey";

// Cash flow (#62, #168): Annual (the default), Monthly and Weekly tabs, each
// first saying whether money came in faster than it went out
// (cashflow.series, #169), then "Where it went": the period as a Sankey in
// five levels: where the money came from; take-home and what came off the
// paycheck first; where it went (spending, investing, cash savings, debt);
// the breakdown; and subcategories. Switching tabs keeps the period
// (lib/cashflow/view.ts). Built from the same numbers as Budgets and
// Spending, so the pages agree. Display only.

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
    debt: sum((l) => l.target === "bucket:debt"),
    other: sum((l) => l.target === "bucket:other"),
  };
}

export default async function CashFlowPage(props: PageProps<"/cash-flow">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const period = parseView(sp, today);
  const by: Grouping = GROUPINGS.some((g) => g.id === one(sp.by)) ? (one(sp.by) as Grouping) : "category";
  const gross = one(sp.gross) === "1";
  const percent = one(sp.show) === "percent";

  const db = getDb();
  const [{ paychecks, lines, transfers, uncategorized, accounts, lookup, uncategorizedOut, unmatched }, misfiled, flow] = await Promise.all([
    cashFlowInputs(db, { from: period.from, to: period.to, gross }),
    read(db, misfiledTransfers, { from: period.from, to: period.to }),
    read(db, cashFlowSeries, { from: period.from, to: period.to, gross }),
  ]);
  const graph = buildFlowGraph({ paychecks, lines, uncategorized, transfers, accounts, by, lookup });
  const t = totals(graph);
  // Percent mode's 100%: all the money in for the period, income and what
  // was drawn on, which is also everything that went out.
  const totalIn = t.income + t.drawn;
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));

  const href = (next: { period?: ViewPeriod; by?: Grouping; gross?: boolean; percent?: boolean }) => {
    const q = new URLSearchParams();
    const p = next.period ?? period;
    // This year's Annual is the page's default: a bare /cash-flow.
    const isDefault = p.view === "annual" && p.key === today.slice(0, 4);
    if (!isDefault) for (const [k, v] of Object.entries(viewQuery(p))) q.set(k, v);
    if ((next.by ?? by) !== "category") q.set("by", next.by ?? by);
    if (next.gross ?? gross) q.set("gross", "1");
    if (next.percent ?? percent) q.set("show", "percent");
    const qs = q.toString();
    return `/cash-flow${qs ? `?${qs}` : ""}`;
  };
  const tab = (current: boolean) => (current ? "font-medium" : "text-muted-foreground hover:text-foreground");
  const earlier = step(period, -1, today);
  const later = step(period, 1, today);
  const soFar = period.from <= today && today <= period.to;
  const totalsFlow = flow.totals;
  // The same uncategorized money the Sankey shows, so the two can be reconciled.
  const uncategorizedIn = uncategorized.filter((u) => u.amountCents > 0).reduce((sum, u) => sum + u.amountCents, 0);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">Cash flow</h1>
          <nav aria-label="Period" className="flex items-center gap-3 text-sm">
            {earlier ? (
              <Link href={href({ period: earlier })} className="text-muted-foreground hover:text-foreground">
                ← Earlier
              </Link>
            ) : null}
            <span className="font-medium">{period.label}</span>
            {later ? (
              <Link href={href({ period: later })} className="text-muted-foreground hover:text-foreground">
                Later →
              </Link>
            ) : null}
          </nav>
        </div>
        {/* Each tab keeps the period: March's Monthly opens 2026's Annual. */}
        <nav aria-label="Cash flow views" className="flex flex-wrap gap-1 text-sm">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              href={href({ period: switchTo(period, v.id as CashFlowView, today) })}
              aria-current={v.id === period.view ? "page" : undefined}
              className={`rounded-md px-3 py-1 ${v.id === period.view ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {v.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Is money coming in faster than it goes out? (#169) */}
      <section aria-label="In and out" className="space-y-2">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          {[
            { name: `Cash in${soFar ? " so far" : ""}`, cents: totalsFlow.inCents, tone: "" },
            { name: `Cash out${soFar ? " so far" : ""}`, cents: totalsFlow.outCents, tone: "" },
            { name: "Net", cents: totalsFlow.netCents, tone: totalsFlow.netCents < 0 ? "text-negative" : totalsFlow.netCents > 0 ? "text-positive" : "" },
          ].map((f) => (
            <div key={f.name} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{f.name}</dt>
              <dd className={`text-lg font-semibold tabular-nums ${f.tone}`}>
                {f.name === "Net" && f.cents > 0 ? "+" : f.cents < 0 ? "−" : ""}
                {formatCents(Math.abs(f.cents))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Cash in is paychecks (what landed) and income; cash out is spending, net of refunds{gross ? "" : " and friends' shares"}. Moving money between
          your own accounts, card payments included, is neither.
        </p>
        {uncategorizedIn || uncategorizedOut.cents ? (
          // Not cash in or out until it's filed (#169); "Where it went" shows it as Uncategorized, so the two differ by this much.
          <p className="text-xs text-warning">
            Not counted until categorized: {[uncategorizedIn ? `${formatCents(uncategorizedIn)} in` : null, uncategorizedOut.cents ? `${formatCents(uncategorizedOut.cents)} out` : null].filter(Boolean).join(" and ")}
            , which &ldquo;Where it went&rdquo; shows as Uncategorized.{" "}
            <Link href="/inbox" className="underline">
              File them in Inbox
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="where-it-went" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="where-it-went" className="text-lg font-medium">
            Where it went
          </h2>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <nav aria-label="Show amounts as" className="flex gap-3">
            <Link href={href({ percent: false })} aria-current={!percent ? "page" : undefined} className={tab(!percent)}>
              $
            </Link>
            <Link href={href({ percent: true })} aria-current={percent ? "page" : undefined} className={tab(percent)}>
              %
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
          ["Other transfers out", t.other, "var(--muted-foreground)"],
        ].map(([name, cents, color]) =>
          cents || name === "Income" || name === "Spent" ? (
            <div key={name as string} className="rounded-lg border p-3">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ background: color as string }} aria-hidden />
                {name}
              </dt>
              <dd className="tabular-nums">
                {percent ? formatShare(cents as number, totalIn) : formatCents(cents as number)}
                {percent ? <span className="ml-1 text-xs text-muted-foreground">{formatCents(cents as number)}</span> : null}
              </dd>
            </div>
          ) : null,
        )}
      </dl>

      <p className="text-sm text-muted-foreground">
        Left to right: where the money came from (including what you drew on: savings, investments, cash on hand); take-home and what came off
        your pay first; where it went; and the breakdown. Spending is net, the same as Budgets. A card charge is spending when it&apos;s made,
        and paying the card off is never counted again. Moving money between your accounts is never income or spending: it shows as saved,
        invested, paid down or drawn on, net for the period. Only paychecks
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

      <MisfiledTransfers pairs={misfiled} />

      {unmatched.length ? (
        // A transfer with no other half is either money that left for an
        // account that isn't connected (fine), or something filed as a
        // transfer that wasn't one (it then hides spending or income).
        <details className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <summary className="cursor-pointer">
            {unmatched.length} transfer{unmatched.length === 1 ? " is" : "s are"} missing {unmatched.length === 1 ? "its" : "their"} other half
          </summary>
          <p className="mt-1 text-xs">
            Filed as a transfer, but no matching amount arrived in (or left) another of your accounts within 5 days. Usually the other account
            isn&apos;t connected, which is fine. If it wasn&apos;t a transfer, file it as spending or income, or it&apos;s left out of both.
          </p>
          <ul className="mt-2 divide-y divide-warning/30 text-foreground">
            {unmatched.map((u) => (
              <li key={u.transactionId}>
                <Link href={`/transactions/${u.transactionId}`} className="flex justify-between gap-3 py-1.5 hover:underline">
                  <span className="min-w-0 truncate">
                    {u.postedOn} · {u.accountName} · {u.label}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCents(u.amountCents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {graph.links.length === 0 ? (
        <p className="text-muted-foreground">Nothing categorized in {period.label} yet.</p>
      ) : (
        <>
          <Sankey graph={graph} label={`Cash flow for ${period.label}`} percentOf={percent ? totalIn : null} />
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
                    Share
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
                      <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{formatShare(l.valueCents, totalIn)}</td>
                      <td className="py-1 text-right tabular-nums">{l.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      )}
      </section>
    </div>
  );
}
