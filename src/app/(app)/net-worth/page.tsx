import Link from "next/link";
import { KIND_LABELS, type AccountKind } from "@/lib/account-kinds";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { isLiability, netWorthSummary } from "@/lib/net-worth";
import { investmentIncome } from "@/operations/investments";
import { read } from "@/operations/runtime";
import { ManualBadge } from "../accounts/account-row";
import { CASH_KINDS, INVESTMENT_KINDS } from "@/lib/investments/activity";
import { NetWorthHistory } from "./history";
import { pricesNote } from "@/lib/prices/describe";
import { ValueChart } from "@/components/charts/value-chart";
import { GROUP_LABELS, forecast, forecastStart, parseAssumptions, type ForecastGroup } from "@/lib/forecast";
import { rebuiltHistory, type RebuiltHistory } from "@/lib/prices/rebuilt";
import { hourlyNetWorth } from "@/lib/net-worth-hourly";
import { refreshPricesAfterResponse } from "@/lib/prices/after-response";
import { privacyMode } from "@/lib/privacy/server";

// Net worth today and over time (#25), and a forecast on the owner's own
// assumptions (#233). Read-only: balances come from syncs, how each kind
// counts is explained in src/lib/net-worth.ts, and the forecast's
// assumptions are only in the URL.
export default async function NetWorthPage(props: PageProps<"/net-worth">) {
  await privacyMode();
  const assumptions = parseAssumptions(await props.searchParams);
  const db = getDb();
  // The trailing twelve months, from the first of the month eleven months ago.
  const now = new Date();
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const [summary, income, rebuilt] = await Promise.all([
    netWorthSummary(db, { today: now }),
    read(db, investmentIncome, { from: yearAgo }),
    rebuiltHistory(db, now.toISOString().slice(0, 10)),
  ]);
  // Net worth by the hour for the chart's short ranges (#338), from the same summary.
  const hourly = await hourlyNetWorth(db, summary, { now });
  // Values move with prices (#230): refresh them after this page is sent, if due.
  refreshPricesAfterResponse();
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
          <NetWorthHistory
            accounts={summary.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, kind: a.kind }))}
            daily={summary.daily}
            hourly={hourly}
          />
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

      {rebuilt.days.length ? (
        <Rebuilt
          history={rebuilt}
          names={new Map([...summary.accounts, ...summary.excluded.map((e) => e.account)].map((a) => [a.id, a.name]))}
          balancesFrom={historyStart ?? null}
        />
      ) : null}

      {summary.accounts.length ? <Forecast accounts={summary.accounts} assumptions={assumptions} /> : null}

      {summary.accounts.length ? <Split accounts={summary.accounts} /> : null}

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
                    className={`block h-full rounded-sm ${isLiability(k.kind) ? "bg-negative/70" : "bg-primary"}`}
                    style={{ width: `${(Math.abs(k.cents) / largest) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{formatCents(k.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {income.byMonth.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Investment income</h2>
          {/* Kept apart from budget income on purpose: it comes from what
              you hold, not your paycheck, and those accounts are out of
              budgets. Reinvested dividends still count; the reinvestment
              itself is a buy. */}
          <p className="text-sm text-muted-foreground tabular-nums">
            {formatCents(income.totalCents)} in the last 12 months: {formatCents(income.dividendsCents)} in dividends,{" "}
            {formatCents(income.interestCents)} in interest.
          </p>
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Month</th>
                <th className="py-1 text-right font-normal">Dividends</th>
                <th className="py-1 text-right font-normal">Interest</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {income.byMonth.map((m) => (
                <tr key={m.month}>
                  <td className="py-1">
                    {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}
                  </td>
                  <td className="py-1 text-right">{m.dividendsCents ? formatCents(m.dividendsCents) : "—"}</td>
                  <td className="py-1 text-right">{m.interestCents ? formatCents(m.interestCents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

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
                  {a.balanceAt ? ` · ${a.live ? "balance " : ""}as of ${a.balanceAt.toISOString().slice(0, 10)}` : ""}
                  {pricesNote(a.live)}
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

// Where net worth sits today (#134): what's owned against what's owed, and
// what's owned as cash, investments or other assets. Two simple bars, each
// segment labelled, so the split never rests on colour alone.
function Split({ accounts }: { accounts: { kind: AccountKind; contributionCents: number | null }[] }) {
  const sum = (pick: (k: AccountKind) => boolean) => accounts.filter((a) => pick(a.kind)).reduce((s, a) => s + (a.contributionCents ?? 0), 0);
  const owed = -sum((k) => isLiability(k));
  const cash = sum((k) => CASH_KINDS.includes(k));
  const investments = sum((k) => INVESTMENT_KINDS.includes(k));
  const other = sum((k) => !isLiability(k) && !CASH_KINDS.includes(k) && !INVESTMENT_KINDS.includes(k));
  const assets = cash + investments + other;
  const rows = [
    { label: "Owned and owed", parts: [{ name: "Assets", cents: assets, color: "var(--series-1)" }, { name: "Owed", cents: owed, color: "var(--series-8)" }] },
    {
      label: "What you own",
      parts: [
        { name: "Cash", cents: cash, color: "var(--series-1)" },
        { name: "Investments", cents: investments, color: "var(--series-7)" },
        { name: "Other assets", cents: other, color: "var(--series-5)" },
      ],
    },
  ];
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Where it sits</h2>
      {rows.map((row) => {
        const parts = row.parts.filter((p) => p.cents > 0);
        const whole = parts.reduce((s, p) => s + p.cents, 0) || 1;
        return (
          <div key={row.label} className="space-y-1 text-sm">
            <div className="text-xs text-muted-foreground">{row.label}</div>
            <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm" aria-hidden>
              {parts.map((p) => (
                <span key={p.name} className="h-full" style={{ width: `${(p.cents / whole) * 100}%`, background: p.color }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
              {parts.map((p) => (
                <span key={p.name} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
                  {p.name} {formatCents(p.cents)} <span className="text-muted-foreground">({Math.round((p.cents / whole) * 100)}%)</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// The forecast (#233): today's live net worth, by group, carried forward on
// the assumptions in the URL. A plain GET form, so each scenario is a link
// and trying one writes nothing.
function Forecast({
  accounts,
  assumptions,
}: {
  accounts: Parameters<typeof forecastStart>[0];
  assumptions: ReturnType<typeof parseAssumptions>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const points = forecast(forecastStart(accounts), assumptions, today);
  const end = points.at(-1)!;
  const groups: [ForecastGroup, string][] = [
    ["cash", "cash"],
    ["investments", "inv"],
    ["other", "other"],
  ];
  const field = "h-8 w-20 rounded-md border bg-background px-2 text-sm tabular-nums";
  return (
    <section className="space-y-3" aria-label="Forecast">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Forecast</h2>
        <p className="text-sm text-muted-foreground">
          A scenario on your own assumptions, not a prediction or advice. Each group grows at its yearly rate, compounded monthly;
          the monthly amount goes into investments; debts stay as they are.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
        <ValueChart
          label="Forecast net worth"
          height={200}
          ranges={false}
          series={points.map((p) => ({
            on: p.on,
            cents: p.cents,
            detail: `Cash ${formatCents(p.groups.cash)} · Investments ${formatCents(p.groups.investments)} · Other ${formatCents(p.groups.other)}${p.groups.debts ? ` · Debts ${formatCents(p.groups.debts)}` : ""}`,
          }))}
        />
        {/* The assumptions beside the curve, editable in place. */}
        <form action="/net-worth" className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">Assumptions</p>
          {groups.map(([group, name]) => (
            <label key={group} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{GROUP_LABELS[group]}, per year</span>
              <span className="flex items-center gap-1">
                <input name={name} type="number" step="0.1" min={-50} max={50} defaultValue={assumptions.ratesPct[group]} className={field} />%
              </span>
            </label>
          ))}
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Added monthly</span>
            <span className="flex items-center gap-1">
              $<input name="add" type="number" step="1" min={0} defaultValue={assumptions.monthlyCents / 100} className={field} />
            </span>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Years</span>
            <input name="years" type="number" step="1" min={1} max={40} defaultValue={assumptions.years} className={field} />
          </label>
          <button type="submit" className="h-8 w-full rounded-md border px-3 hover:bg-accent">
            Update
          </button>
          <p className="border-t pt-2 text-xs text-muted-foreground tabular-nums">
            In {assumptions.years} {assumptions.years === 1 ? "year" : "years"}: <span className="font-medium text-foreground">{formatCents(end.cents)}</span>
          </p>
        </form>
      </div>
    </section>
  );
}

// History rebuilt from trades (#232): the market value of the positions in
// every account with trades, from the earliest trade. It reaches further
// back than balance history, which starts when syncing did, but it's only
// positions: each account names where its coverage starts, and any day not
// every account covers is labelled partial. Nothing is guessed.
function Rebuilt({ history, names, balancesFrom }: { history: RebuiltHistory; names: Map<string, string>; balancesFrom: string | null }) {
  const n = history.accounts.length;
  const series = history.total
    .filter((p) => p.counted > 0)
    .map((p) => ({ on: p.on, cents: p.cents, detail: p.complete ? `All ${n} traded ${n === 1 ? "account" : "accounts"}` : `Partial: ${p.counted} of ${n} accounts` }));
  return (
    <section className="space-y-2" aria-label="Rebuilt from your trades">
      <h2 className="text-lg font-medium">Rebuilt from your trades</h2>
      <p className="text-sm text-muted-foreground">
        What your positions were worth each day: the quantity your trades say you held, at that day&apos;s closing price. Positions
        only, not cash{balancesFrom ? `; your full net worth history above starts ${balancesFrom}` : ""}.
        {history.completeFrom ? ` Every traded account is covered from ${history.completeFrom}; before that it's partial.` : ""}
      </p>
      {series.length > 1 ? (
        <ValueChart label="Positions rebuilt from trades" height={180} series={series} />
      ) : (
        <p className="text-sm text-muted-foreground">Past prices are being filled in; the chart appears once they are.</p>
      )}
      <ul className="divide-y rounded-lg border text-sm">
        {history.accounts.map((a) => (
          <li key={a.accountId} className="flex justify-between gap-3 px-3 py-1.5">
            <span className="truncate">{names.get(a.accountId) ?? "Account"}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {a.coverageStart ? `from ${a.coverageStart}` : "no prices for its holdings yet"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
