import Link from "next/link";
import { KIND_LABELS } from "@/lib/account-kinds";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { isLiability, netWorthSummary } from "@/lib/net-worth";
import { ManualBadge } from "../accounts/account-row";
import { NetWorthChart } from "./net-worth-chart";

// Net worth today and over time (#25). Read-only: balances come from syncs,
// and how each kind counts is explained in src/lib/net-worth.ts.
export default async function NetWorthPage() {
  const summary = await netWorthSummary(getDb());
  const largest = Math.max(1, ...summary.byKind.map((k) => Math.abs(k.cents)));
  const historyStart = summary.series[0]?.on;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Net worth</h1>
        <p className="text-3xl font-semibold tabular-nums">{formatCents(summary.netCents)}</p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {formatCents(summary.assetsCents)} in assets − {formatCents(summary.liabilitiesCents)} owed
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Over time</h2>
        {summary.series.length > 1 ? (
          <NetWorthChart series={summary.series} />
        ) : (
          // Banks only report today's balance, so history can't be
          // backfilled; it builds up one sync at a time.
          <p className="text-sm text-muted-foreground">
            {historyStart
              ? `History starts ${historyStart}. The chart appears after the next daily sync adds a second day.`
              : "No history yet. Each daily sync records every account's balance, and the chart builds from there."}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">By kind</h2>
        {summary.byKind.length === 0 ? (
          <p className="text-sm text-muted-foreground">No balances yet. Connect a bank under Settings.</p>
        ) : (
          <ul className="space-y-2">
            {summary.byKind.map((k) => (
              <li key={k.kind} className="grid grid-cols-[minmax(0,7rem)_1fr_6.5rem] items-center gap-3 text-sm">
                <span className="truncate">
                  {KIND_LABELS[k.kind]}
                  <span className="text-muted-foreground"> · {k.accounts}</span>
                </span>
                {/* Bars share one scale, so a loan and a brokerage account
                    compare honestly. Owed amounts are a different hue, not
                    just a minus sign. */}
                <span className="h-2.5 rounded-sm bg-muted" aria-hidden>
                  <span
                    className={`block h-full rounded-sm ${isLiability(k.kind) ? "bg-red-600/70 dark:bg-red-400/70" : "bg-foreground/70"}`}
                    style={{ width: `${(Math.abs(k.cents) / largest) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{formatCents(k.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Accounts</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {summary.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate">
                  {a.name} {a.manual ? <ManualBadge /> : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {KIND_LABELS[a.kind]}
                  {a.manual && a.institution === "Manual" ? "" : ` · ${a.institution}`}
                  {a.balanceAt ? ` · as of ${a.balanceAt.toISOString().slice(0, 10)}` : ""}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{formatCents(a.contributionCents!)}</span>
            </li>
          ))}
          {summary.excluded.map(({ account, reason }) => (
            <li key={account.id} className="flex items-center justify-between gap-3 px-3 py-2 text-muted-foreground">
              <span className="min-w-0">
                <span className="block truncate">{account.name}</span>
                <span className="block truncate text-xs">
                  Not counted: {reason === "currency" ? `balance is in ${account.currency}` : "no balance reported yet"}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Credit cards and loans count as what&apos;s owed, whichever sign the bank reports. A card with a credit
          balance counts as owing that amount. If an account is the wrong kind, fix it on{" "}
          <Link href="/accounts" className="underline">
            Accounts
          </Link>
          ; its history follows.
        </p>
      </section>
    </div>
  );
}
