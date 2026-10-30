import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { HISTORY_MONTHS } from "@/lib/budgets/engine";
import { backdateRange, budgetHistory, budgetMonthly, budgetPay, budgetStatus, budgetYear, yearlyCharges } from "@/operations/budgets";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { RebalanceForm, TargetForm, type TargetChoice } from "./forms";
import { BudgetOverview } from "./overview";
import { PayStrip } from "./pay-strip";
import { TargetCard } from "./target-card";
import { YearSummary } from "./year-summary";

// Budgets (#7): category targets plus one unallocated buffer, each with its
// own period. ?month=YYYY-MM looks at an earlier month as it stood then —
// targets are versioned, so a past month shows the target it had.

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

export default async function BudgetsPage(props: PageProps<"/budgets">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const requested = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const month = requested > thisMonth ? thisMonth : requested;
  const isCurrent = month === thisMonth;
  // A past month is shown as of its last day.
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

  const db = getDb();
  // Net by default (your share of shared expenses); ?gross=1 shows spending
  // as charged, before what friends owe comes off.
  const gross = sp.gross === "1";
  // The year across every target (#123): the viewed month's, unless ?year= picks another.
  const thisYear = Number(thisMonth.slice(0, 4));
  const monthYear = Number(month.slice(0, 4));
  const yearParam = typeof sp.year === "string" && /^\d{4}$/.test(sp.year) ? Math.min(Number(sp.year), thisYear) : null;
  const year = yearParam ?? monthYear;
  const [status, cats, history, netHistory, monthly, yearly, yearTotals, range, payVsBudget] = await Promise.all([
    read(db, budgetStatus, { on, gross }),
    read(db, listCategories, {}),
    read(db, budgetHistory, { on, gross }),
    // Suggested targets (#106) come from net spend whichever view is shown,
    // since targets are net.
    gross ? read(db, budgetHistory, { on, gross: false }) : null,
    read(db, budgetMonthly, { on, gross }),
    // Yearly bills worth saving toward (#109), for the add form, which only
    // shows on the current month.
    isCurrent ? read(db, yearlyCharges, { on }) : [],
    read(db, budgetYear, { year, gross }),
    // How far back a target can start (#130); the forms only show this month.
    isCurrent ? read(db, backdateRange, {}) : undefined,
    // Pay against the month's budget (#128).
    read(db, budgetPay, { on, gross }),
  ]);
  // What each category usually costs (#105), keyed like the forms' choices.
  const byCategory = (rows: typeof history) =>
    Object.fromEntries(
      rows.map((h) => [h.categoryId ?? "", { averageCents: h.averageCents, months: h.months, overMonths: h.overMonths, comparedMonths: h.comparedMonths }]),
    );
  const histories = byCategory(history);
  const netHistories = netHistory ? byCategory(netHistory) : histories;
  const hrefWith = (next: { month?: string; gross?: boolean; year?: number }) => {
    const q = new URLSearchParams();
    const m = next.month ?? month;
    if (m !== thisMonth) q.set("month", m);
    if (next.gross ?? gross) q.set("gross", "1");
    // Kept only while it differs from the month's own year.
    const y = next.year ?? yearParam;
    if (y !== null && y !== Number(m.slice(0, 4))) q.set("year", String(y));
    const s = q.toString();
    return s ? `/budgets?${s}` : "/budgets";
  };

  // Each target's recent months (#107); a bar opens its month, keeping the view.
  const series = new Map(
    monthly.map((s) => [s.categoryId ?? "", s.months.map((m) => ({ ...m, href: hrefWith({ month: m.month.slice(0, 7) }) }))]),
  );

  const targeted = new Set(status.targets.map((t) => t.categoryId));
  const choices: TargetChoice[] = [
    ...(targeted.has(null) ? [] : [{ categoryId: null, name: "Everything else (buffer)" }]),
    ...categoryOptions(cats)
      .filter((o) => o.kind === "expense" && !targeted.has(o.id))
      .map((o) => ({ categoryId: o.id, name: o.label })),
  ];
  const buffer = status.targets.find((t) => t.categoryId === null);
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Budgets</h1>
        <nav className="flex items-center gap-3 text-sm">
          {/* The 12 months ending here, every target at once (#108). */}
          <Link href={hrefWith({}).replace("/budgets", "/budgets/year")} className="text-muted-foreground underline hover:text-foreground">
            Year view
          </Link>
          <Link href={hrefWith({ month: shiftMonth(month, -1) })} className="text-muted-foreground hover:text-foreground">
            ← Earlier
          </Link>
          <span className="font-medium">{monthLabel}</span>
          {isCurrent ? null : (
            <Link href={hrefWith({ month: shiftMonth(month, 1) })} className="text-muted-foreground hover:text-foreground">
              Later →
            </Link>
          )}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        Net spending in accounts that count toward budgets: refunds offset spending, and transfers, income and
        investment accounts never count. Each category with a target is measured on its own period; everything else
        draws from the buffer.
        {isCurrent ? "" : ` Showing ${monthLabel} as of its last day, with the targets in effect then.`}{" "}
        {gross ? (
          <>
            Showing <strong>gross</strong> spending, before friends&apos; shares come off.{" "}
            <Link href={hrefWith({ gross: false })} className="underline">
              Show your share
            </Link>
          </>
        ) : (
          <>
            Shared expenses count only your share.{" "}
            <Link href={hrefWith({ gross: true })} className="underline">
              Show gross
            </Link>
          </>
        )}
      </p>

      {status.targets.length === 0 ? (
        <p className="text-muted-foreground">
          No targets {isCurrent ? "yet" : "in effect then"}. A good start: a buffer for everything, then targets for the few
          categories you actually want to watch.
        </p>
      ) : (
        <>
          {/* The month at a glance (#122); each row opens its card below. */}
          <BudgetOverview
            targets={status.targets.map((t) => ({
              categoryId: t.categoryId,
              name: t.name,
              start: t.start,
              end: t.end,
              spentCents: t.spentCents,
              availableCents: t.availableCents,
              remainingCents: t.remainingCents,
            }))}
          />
          <PayStrip summary={payVsBudget.summary} pay={payVsBudget.pay} isCurrent={isCurrent} uncategorized={payVsBudget.uncategorized} />
          <ul className="space-y-3">
            {status.targets.map((t) => (
              <TargetCard key={t.categoryId ?? "buffer"} target={t} editable={isCurrent} history={histories[t.categoryId ?? ""]} netHistory={netHistories[t.categoryId ?? ""]} windowMonths={HISTORY_MONTHS}
                bars={series.get(t.categoryId ?? "") ?? []}
                viewedMonth={`${month}-01`}
                partialMonth={isCurrent ? `${month}-01` : null}
                covers={t.categoryId === null ? status.unbudgeted.covers : undefined}
                  backdate={range}
                  transactionsHref={(() => {
                    const q = new URLSearchParams({ target: t.categoryId ?? "buffer" });
                    if (!isCurrent) q.set("month", month);
                    if (gross) q.set("gross", "1");
                    return `/budgets/transactions?${q}`;
                  })()}
              />
            ))}
          </ul>
        </>
      )}

      {/* With a buffer, its card lists what it covers (#110). */}
      {!buffer && status.unbudgeted.byCategory.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Spending without a target</h2>
          <p className="text-xs text-muted-foreground">
            By category this month. Something that shows up here every month may deserve its own target; a buffer
            target (&ldquo;Everything else&rdquo;) would give all of it one shared limit.
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {status.unbudgeted.byCategory.map((c) => (
              <li key={c.categoryId} className="flex justify-between gap-3 px-3 py-1.5">
                <span className="truncate">{c.name}</span>
                <span className="tabular-nums">{formatCents(c.spentCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <YearSummary
        year={year}
        targets={yearTotals.targets}
        total={yearTotals.total}
        isThisYear={year === thisYear}
        yearHref={(y) => `${hrefWith({ year: y })}#year`}
        // A target's year in the Year view: the twelve months ending in December, or this month for this year.
        detailHref={(categoryId) => {
          const q = new URLSearchParams();
          if (year !== thisYear) q.set("month", `${year}-12`);
          if (gross) q.set("gross", "1");
          const s = q.toString();
          return `/budgets/year${s ? `?${s}` : ""}#year-${categoryId ?? "buffer"}`;
        }}
      />

      {isCurrent ? (
        <>
          {status.targets.length >= 2 ? (
            <section className="space-y-2">
              <h2 className="text-lg font-medium">Move budget this period</h2>
              <p className="text-xs text-muted-foreground">
                Shifts money between two targets for the current period only; both targets stay as they are.
              </p>
              <RebalanceForm targets={status.targets.map((t) => ({ categoryId: t.categoryId, name: t.name }))} />
            </section>
          ) : null}
          {choices.length ? (
            <section className="space-y-2 rounded-lg border p-3">
              <h2 className="text-lg font-medium">Add a target</h2>
              <TargetForm
                choices={choices}
                histories={histories}
                suggestFrom={netHistories}
                windowMonths={HISTORY_MONTHS}
                yearly={yearly.filter((y) => choices.some((c) => c.categoryId === y.categoryId))}
                backdate={range}
              />
            </section>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Every change is in <Link href="/activity" className="underline">Activity</Link> and can be undone there.
      </p>
    </div>
  );
}
