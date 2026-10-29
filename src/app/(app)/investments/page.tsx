import Link from "next/link";
import { ManualBadge } from "../accounts/account-row";
import { ValueChart } from "@/components/charts/value-chart";
import { KIND_LABELS } from "@/lib/account-kinds";
import { getDb } from "@/lib/db";
import { combineHoldings } from "@/lib/investments/combine";
import { investmentsSummary, type AllocationSlice } from "@/lib/investments/summary";
import { formatCents } from "@/lib/money";

// Investments (#27): what's held, how it's split, and how it's done against
// what was paid — display only. Data comes from balance and holding
// snapshots (src/lib/investments/summary.ts); nothing here is advice, a
// projection, or a recommendation, and the page says so.

const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

function signedCents(cents: number) {
  return `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatCents(Math.abs(cents))}`;
}

function Gain({ gainCents, basisCents }: { gainCents: number; basisCents: number }) {
  // Color carries direction, and the sign repeats it for anyone who can't
  // tell the two hues apart.
  const tone = gainCents > 0 ? "text-positive" : gainCents < 0 ? "text-negative" : "";
  return (
    <span className={`tabular-nums ${tone}`}>
      {signedCents(gainCents)}
      {basisCents > 0 ? ` (${gainCents >= 0 ? "+" : "−"}${percent(Math.abs(gainCents) / basisCents)})` : ""}
    </span>
  );
}

// Bars on one shared scale (the largest slice), labelled with share and
// amount: the reading that matters is "how much of the whole", and a pie
// makes that harder to compare across more than a few slices.
function Allocation({ slices }: { slices: AllocationSlice[] }) {
  const largest = Math.max(1, ...slices.map((s) => Math.abs(s.cents)));
  return (
    <ul className="space-y-2">
      {slices.map((s) => (
        <li key={s.label} className="grid grid-cols-[minmax(0,5.5rem)_1fr_7rem] items-center gap-2 text-sm sm:grid-cols-[minmax(0,9rem)_1fr_7rem] sm:gap-3">
          <span className="truncate" title={s.label}>
            {s.label}
          </span>
          <span className="h-2.5 rounded-sm bg-muted" aria-hidden>
            <span className="block h-full rounded-sm bg-primary" style={{ width: `${(Math.max(0, s.cents) / largest) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">
            {percent(s.share)} <span className="text-muted-foreground">· {formatCents(s.cents)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Each asset across accounts (#81): total shares (exact decimals), value,
// cost basis where reported, and a row per account behind it.
function HoldingsAcross({ combined }: { combined: ReturnType<typeof combineHoldings> }) {
  const { holdings, cashAndOther, unreported } = combined;
  const columns = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_8rem]";
  return (
    <div className="text-sm">
      <div className={`${columns} hidden border-b pb-1 text-xs text-muted-foreground sm:grid`} aria-hidden>
        <span>Asset</span>
        <span className="text-right">Shares</span>
        <span className="text-right">Value</span>
        <span className="text-right">Cost basis</span>
      </div>
      <ul className="divide-y">
        {holdings.map((h) => (
          <li key={h.key}>
            <details className="group">
              <summary className={`${columns} cursor-pointer list-none py-2`}>
                <span className="min-w-0">
                  <span className="block truncate">
                    <span className="mr-1 inline-block text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>
                      ▸
                    </span>
                    {h.symbol ? <span className="font-medium">{h.symbol} </span> : null}
                    <span className={h.symbol ? "text-muted-foreground" : ""}>{h.description}</span>
                  </span>
                  <span className="block pl-4 text-xs text-muted-foreground">
                    {h.accounts.length === 1 ? h.accounts[0].accountName : `${h.accounts.length} accounts`}
                    <span className="sm:hidden tabular-nums"> · {h.shares} shares</span>
                  </span>
                </span>
                <span className="hidden text-right tabular-nums sm:block">{h.shares}</span>
                <span className="text-right tabular-nums">{formatCents(h.marketValueCents)}</span>
                <span className="hidden text-right tabular-nums sm:block">
                  {h.costBasisCents === null ? (
                    <span className="text-muted-foreground">not reported</span>
                  ) : (
                    <>
                      {formatCents(h.costBasisCents)}
                      {h.basisComplete ? null : <span className="block text-xs text-muted-foreground">some accounts only</span>}
                    </>
                  )}
                </span>
              </summary>
              <table className="mb-2 ml-4 w-[calc(100%-1rem)] text-xs">
                <caption className="sr-only">
                  {h.symbol ?? h.description} by account
                </caption>
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="text-left font-normal">
                      Account
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Shares
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Value
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Cost basis
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {h.accounts.map((a) => (
                    <tr key={a.accountId} className="border-t">
                      <td className="py-1 pr-2">{a.accountName}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{a.shares}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{formatCents(a.marketValueCents)}</td>
                      <td className="py-1 text-right tabular-nums">{a.costBasisCents === null ? "—" : formatCents(a.costBasisCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </li>
        ))}
        {cashAndOther.length ? (
          <li className={`${columns} py-2 text-muted-foreground`}>
            <span className="min-w-0">
              <span className="block pl-4">Cash and other</span>
              <span className="block truncate pl-4 text-xs">{cashAndOther.map((c) => `${c.accountName} ${formatCents(c.cents)}`).join(" · ")}</span>
            </span>
            <span className="hidden sm:block" />
            <span className="text-right tabular-nums">{formatCents(cashAndOther.reduce((s, c) => s + c.cents, 0))}</span>
            <span className="hidden sm:block" />
          </li>
        ) : null}
        {unreported.map((u) => (
          <li key={u.accountName} className={`${columns} py-2 text-muted-foreground`}>
            <span className="block truncate pl-4">{u.accountName} (positions not reported)</span>
            <span className="hidden sm:block" />
            <span className="text-right tabular-nums">{formatCents(u.cents)}</span>
            <span className="hidden sm:block" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function InvestmentsPage() {
  const summary = await investmentsSummary(getDb());
  const combined = combineHoldings(summary.accounts);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Investments</h1>
        <p className="text-3xl font-semibold tabular-nums">{formatCents(summary.totalCents)}</p>
        <p className="text-sm text-muted-foreground">
          Brokerage and retirement accounts. Balances and positions come from the daily bank sync (SimpleFIN), or from
          your own entries for manual accounts, and each is shown with the day it&apos;s as of. Display only — not
          investment advice.
        </p>
      </div>

      {summary.accounts.length === 0 ? (
        <p className="text-muted-foreground">
          No investment accounts yet. Connect a brokerage under Settings, mark an account as brokerage or retirement on{" "}
          <Link href="/accounts" className="underline">
            Accounts
          </Link>
          , or add one by hand there.
        </p>
      ) : (
        <>
          {summary.withBasis.positions > 0 ? (
            <section className="space-y-1">
              <h2 className="text-lg font-medium">Unrealized gain or loss</h2>
              <p className="text-2xl">
                <Gain gainCents={summary.withBasis.gainCents} basisCents={summary.withBasis.costBasisCents} />
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {formatCents(summary.withBasis.marketValueCents)} now against {formatCents(summary.withBasis.costBasisCents)}{" "}
                paid, across {summary.withBasis.positions} position{summary.withBasis.positions === 1 ? "" : "s"} with a cost
                basis.
                {summary.positionsWithoutBasis
                  ? ` ${summary.positionsWithoutBasis} position${summary.positionsWithoutBasis === 1 ? " has" : "s have"} no cost basis from the brokerage and ${summary.positionsWithoutBasis === 1 ? "isn't" : "aren't"} included.`
                  : ""}
              </p>
            </section>
          ) : null}

          <section className="space-y-2">
            <h2 className="text-lg font-medium">By account</h2>
            <Allocation slices={summary.byAccount} />
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-medium">By holding</h2>
            <p className="text-xs text-muted-foreground">
              The same holding in several accounts is combined. &quot;Cash and other&quot; is the part of a balance the
              brokerage&apos;s position list doesn&apos;t cover.
            </p>
            <Allocation slices={summary.byHolding} />
          </section>

          {combined.holdings.length ? (
            <section className="space-y-2">
              <h2 className="text-lg font-medium">Holdings across accounts</h2>
              <p className="text-xs text-muted-foreground">
                Each asset&apos;s total shares, value and cost basis, wherever it&apos;s held; open one for the split by
                account. Positions combine by symbol, or by an identical description when there&apos;s none. Cash and
                other stays separate.
              </p>
              <HoldingsAcross combined={combined} />
            </section>
          ) : null}

          {summary.accounts.map((a) => (
            <section key={a.id} className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-medium">
                    {a.name} {a.manual ? <ManualBadge /> : null}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {KIND_LABELS[a.kind]}
                    {a.manual && a.institution === "Manual" ? "" : ` · ${a.institution}`}
                    {a.balanceAt ? ` · balance as of ${a.balanceAt.toISOString().slice(0, 10)}` : ""}
                    {a.holdingsOn ? ` · positions as of ${a.holdingsOn}` : ""}
                  </p>
                </div>
                <p className="text-lg tabular-nums">{formatCents(a.valueCents)}</p>
              </div>

              {a.series.length > 1 ? (
                <ValueChart
                  label={`${a.name} value`}
                  height={160}
                  series={a.series.map((p) => ({
                    on: p.on,
                    cents: p.cents,
                    detail: p.holdingsCents === null ? undefined : `Positions ${formatCents(p.holdingsCents)}`,
                  }))}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Value history builds up one daily sync at a time.</p>
              )}

              {a.holdingsOn ? (
                <ul className="divide-y text-sm">
                  {a.positions.map((p) => (
                    <li key={p.externalId} className="flex items-start justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate">
                          {p.symbol ? <span className="font-medium">{p.symbol} </span> : null}
                          <span className={p.symbol ? "text-muted-foreground" : ""}>{p.description}</span>
                        </span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {p.shares} shares
                          {p.costBasisCents !== null ? ` · cost ${formatCents(p.costBasisCents)}` : " · no cost basis reported"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block tabular-nums">{formatCents(p.marketValueCents)}</span>
                        {p.gainCents !== null ? (
                          <span className="block text-xs">
                            <Gain gainCents={p.gainCents} basisCents={p.costBasisCents!} />
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                  {a.cashAndOtherCents ? (
                    <li className="flex items-start justify-between gap-3 py-2 text-muted-foreground">
                      <span>Cash and other</span>
                      <span className="tabular-nums">{formatCents(a.cashAndOtherCents)}</span>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {a.manual
                    ? "A manual account has a value only, no positions."
                    : "This brokerage hasn't reported positions through the sync, so only the balance is shown."}
                </p>
              )}
            </section>
          ))}

          {summary.excluded.length ? (
            <p className="text-xs text-muted-foreground">
              Not included:{" "}
              {summary.excluded
                .map((e) => `${e.name} (${e.reason === "currency" ? "not in USD" : "no balance reported yet"})`)
                .join(", ")}
              .
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
