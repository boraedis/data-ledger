import Link from "next/link";
import { notFound } from "next/navigation";
import { periodBreakdown, type Share } from "@/lib/budgets/breakdown";
import { burndown, spendCalendar } from "@/lib/budgets/burndown";
import { HISTORY_MONTHS } from "@/lib/budgets/engine";
import { historyLabel, suggestedTargetCents } from "@/lib/budgets/format";
import { budgetHref, budgetView, itemHref } from "@/lib/budgets/tabs";
import { versionSpans } from "@/lib/budgets/target-list";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { backdateRange, budgetDaily, budgetHistory, budgetMonthly, budgetStatus, listTargets, targetTransactions, yearlyCharges } from "@/operations/budgets";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { RebalanceForm } from "../forms";
import { Burndown, SpendCalendar } from "../daily";
import { MonthBars } from "../month-bars";
import { BudgetTabs } from "../tabs";
import { TargetSettings } from "./settings";
import { ItemStatus } from "./status";

// One budget item (#174): a category's target, or the buffer's, and the
// place to analyse and change it. This period's status, spending over the
// last 6, 12 or 24 months against the target each month had, what it
// usually costs and a suggested amount, the target and every version of it
// (past ones editable through the backdate review), moving budget, and the
// period's transactions broken down. The Month view lists targets; this is
// where each one is set up.
//
// /budgets/<category id> or /budgets/buffer, with the tabs' ?month= and
// ?gross=1, and ?months= for the chart.

const RANGES = [6, 12, 24] as const;

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

function Shares({ title, shares, total }: { title: string; shares: Share[]; total: number }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="divide-y rounded-lg border text-sm">
        {shares.map((s) => (
          <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5">
            <span className="truncate">
              {s.name} <span className="text-xs text-muted-foreground">· {s.lines}</span>
            </span>
            <span className="text-right tabular-nums">{formatCents(s.spentCents)}</span>
            {/* Share of the period's spending. */}
            <span className="col-span-2 mt-1 h-1 rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-primary/60" style={{ width: `${total > 0 ? Math.max(0, (s.spentCents / total) * 100) : 0}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function BudgetItemPage(props: PageProps<"/budgets/[target]">) {
  const [{ target }, sp] = await Promise.all([props.params, props.searchParams]);
  if (target !== "buffer" && !/^[0-9a-f-]{36}$/.test(target)) notFound();
  const categoryId = target === "buffer" ? null : target;

  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  const { month, thisMonth, gross } = view;
  const isCurrent = month === thisMonth;
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const months = RANGES.find((r) => String(r) === sp.months) ?? 12;

  const db = getDb();
  const cats = await read(db, listCategories, {});
  const option = categoryOptions(cats).find((o) => o.id === categoryId);
  // Only expense categories take targets; anything else isn't a budget item.
  if (categoryId !== null && (!option || option.kind !== "expense")) notFound();
  const name = categoryId === null ? "Everything else (buffer)" : option!.label;

  const [status, versions, monthly, history, netHistory, yearly, range, txns, daily] = await Promise.all([
    read(db, budgetStatus, { on, gross }),
    read(db, listTargets, {}),
    read(db, budgetMonthly, { on, gross, months, includeEnded: true }),
    read(db, budgetHistory, { on, gross }),
    // Suggested amounts (#106) come from net spend: targets are net.
    gross ? read(db, budgetHistory, { on, gross: false }) : null,
    read(db, yearlyCharges, { on: today }),
    read(db, backdateRange, {}),
    read(db, targetTransactions, { categoryId, on, gross }),
    // The period day by day, and the last three before it (#149).
    read(db, budgetDaily, { categoryId, on, gross }),
  ]);
  const t = status.targets.find((x) => x.categoryId === categoryId) ?? null;
  const spans = versionSpans(versions, categoryId);
  // The version in effect today: what "Change target" starts from.
  const current = spans.findLast((s) => s.effectiveFrom <= today);
  const inEffectNow = current && current.amountCents !== null ? current : null;
  const own = (rows: typeof history | null) => rows?.find((h) => h.categoryId === categoryId);
  const h = own(history);
  const net = own(netHistory) ?? h;
  const suggestion = suggestedTargetCents(net, inEffectNow?.periodMonths ?? 1);
  const series = monthly.find((r) => r.categoryId === categoryId);
  const bars = (series?.months ?? []).map((m) => ({ ...m, href: itemHref(categoryId, { ...view, month: m.month.slice(0, 7) }) }));
  const targeted = bars.filter((b) => b.targetCents !== null);
  const breakdown = txns ? periodBreakdown(txns.lines) : null;
  const through = daily ? (on < daily.end ? on : daily.end) : on;
  const burn = daily ? burndown(daily, through, daily.past) : null;
  const calendar = daily ? spendCalendar(daily, through) : null;
  const href = (next: { month?: string; months?: number }) => {
    const base = itemHref(categoryId, { ...view, month: next.month ?? month });
    const m = next.months ?? months;
    return m === 12 ? base : `${base}${base.includes("?") ? "&" : "?"}months=${m}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={budgetHref("/budgets/month", view)} className="text-sm text-muted-foreground hover:text-foreground">
          ← Budgets
        </Link>
        <BudgetTabs current={null} view={view} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{name}</h1>
        <nav aria-label="Month" className="flex items-center gap-3 text-sm">
          <Link href={href({ month: shiftMonth(month, -1) })} className="text-muted-foreground hover:text-foreground">
            ← Earlier
          </Link>
          <span className="font-medium">{monthLabel(month)}</span>
          {isCurrent ? null : (
            <Link href={href({ month: shiftMonth(month, 1) })} className="text-muted-foreground hover:text-foreground">
              Later →
            </Link>
          )}
        </nav>
      </div>

      {/* The current month's period is in progress through its last day, as on the cards (#147). */}
      {t ? (
        <ItemStatus t={t} inProgress={isCurrent} />
      ) : (
        <p className="text-sm text-muted-foreground">No target in effect {isCurrent ? "now" : `in ${monthLabel(month)}`}.</p>
      )}

      <section className="space-y-2" aria-label="Spending over time">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Spending, last {months} months</h2>
          <nav aria-label="Months shown" className="flex gap-1 text-sm">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={href({ months: r })}
                aria-current={r === months ? "true" : undefined}
                className={`rounded-md px-2 py-0.5 ${r === months ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground"}`}
              >
                {r}
              </Link>
            ))}
          </nav>
        </div>
        {bars.length ? (
          <>
            <MonthBars bars={bars} viewedMonth={`${month}-01`} partialMonth={isCurrent ? `${month}-01` : null} />
            <p className="text-xs text-muted-foreground tabular-nums">
              {targeted.length
                ? `Over target in ${targeted.filter((b) => b.spentCents > b.targetCents!).length} of ${targeted.length} ${targeted.length === 1 ? "month" : "months"} with a target. `
                : ""}
              Tap a month to look at it here.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Set a target to see its months here.</p>
        )}
        <div className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground tabular-nums">
          <p>{historyLabel(h, HISTORY_MONTHS)}.</p>
          {suggestion !== null ? (
            <p>
              Suggested target: <span className="font-medium text-foreground">{formatCents(suggestion)}</span>
              {inEffectNow ? ` ${inEffectNow.periodMonths === 1 ? "a month" : "a period"}` : " a month"}, from that average
              {inEffectNow && inEffectNow.amountCents !== null
                ? inEffectNow.amountCents === suggestion
                  ? " — the same as now."
                  : ` (now ${formatCents(inEffectNow.amountCents)}).`
                : "."}
            </p>
          ) : null}
        </div>
      </section>

      {daily && burn && calendar ? (
        <section className="space-y-3" aria-label="Day by day">
          <h2 className="text-lg font-medium">Day by day</h2>
          <Burndown
            days={burn.days}
            availableCents={daily.availableCents}
            pastPeriods={burn.pastPeriods}
            title={`What's left of ${name}'s ${formatCents(daily.availableCents)} through ${monthLabel(daily.start.slice(0, 7))}${daily.start.slice(0, 7) === daily.end.slice(0, 7) ? "" : ` – ${monthLabel(daily.end.slice(0, 7))}`}`}
          />
          <p className="text-xs text-muted-foreground">
            {burn.pastPeriods
              ? `Typical: the same days of the last ${burn.pastPeriods === 1 ? "period" : `${burn.pastPeriods} periods`}, as a share of each one's target, so a changed target still compares.`
              : "No complete period before this one to compare with yet."}
          </p>
          <SpendCalendar days={calendar.days} share={calendar.share} today={isCurrent ? today : null} />
        </section>
      ) : null}

      <TargetSettings
        categoryId={categoryId}
        name={name}
        current={inEffectNow}
        spans={spans}
        history={h}
        netHistory={net}
        windowMonths={HISTORY_MONTHS}
        backdate={range}
        yearly={yearly.filter((y) => y.categoryId === categoryId)}
      />

      {isCurrent && t && status.targets.length >= 2 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Move budget this period</h2>
          <p className="text-xs text-muted-foreground">
            Shifts money into {name} from another target, or out of it, for the current period only; both targets stay as they are.
          </p>
          <RebalanceForm
            targets={status.targets.map((x) => ({ categoryId: x.categoryId, name: x.name }))}
            initialFrom={status.targets.find((x) => x.categoryId !== categoryId)?.categoryId ?? null}
            initialTo={categoryId}
          />
        </section>
      ) : null}

      {txns && breakdown ? (
        <section id="transactions" className="scroll-mt-4 space-y-3">
          <h2 className="text-lg font-medium">
            Transactions{t ? `, ${t.start.slice(0, 7) === t.end.slice(0, 7) ? monthLabel(t.start.slice(0, 7)) : "this period"}` : ""}
            {on < txns.end ? " so far" : ""}
          </h2>
          <p className="text-xs text-muted-foreground">
            {gross ? "Amounts as charged." : "Your share of shared expenses."}
            {categoryId === null ? " Every expense category without a target of its own." : ""} Everything counted toward this target,
            so it adds up to its spent figure.
          </p>
          {txns.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing spent{on < txns.end ? " yet" : ""}.</p>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {breakdown.byCategory.length > 1 ? <Shares title="By category" shares={breakdown.byCategory} total={breakdown.spentCents} /> : null}
                <Shares title="By merchant" shares={breakdown.byMerchant.slice(0, 8)} total={breakdown.spentCents} />
              </div>
              <ul className="divide-y rounded-lg border text-sm">
                {txns.lines.map((l, i) => (
                  <li key={`${l.transactionId}-${i}`}>
                    <Link href={`/transactions/${l.transactionId}`} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-accent">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{l.merchant ?? l.description}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {day(l.date)} · {l.accountName} · {l.categoryName}
                          {l.splitPart ? " · part of a split" : ""}
                        </span>
                      </span>
                      {/* Spending as a positive amount; a refund shows as money back. */}
                      <span className={`shrink-0 tabular-nums ${l.amountCents > 0 ? "text-positive" : ""}`}>
                        {l.amountCents > 0 ? `−${formatCents(l.amountCents)}` : formatCents(-l.amountCents)}
                      </span>
                    </Link>
                  </li>
                ))}
                <li className="flex justify-between gap-3 px-3 py-2 font-medium">
                  <span>
                    Spent ({txns.lines.length} {txns.lines.length === 1 ? "line" : "lines"})
                  </span>
                  <span className="tabular-nums">{formatCents(txns.totalCents)}</span>
                </li>
              </ul>
              {txns.totalCents !== txns.spentCents ? (
                // Shouldn't happen: both come from the same lines. Said rather than hidden if it ever does.
                <p className="text-xs text-warning">
                  This list totals {formatCents(txns.totalCents)}, but the target shows {formatCents(txns.spentCents)}.
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {categoryId === null && status.unbudgeted.covers ? <Covers covers={status.unbudgeted.covers} view={view} /> : null}

      <p className="text-xs text-muted-foreground">
        Every change is in <Link href="/activity" className="underline">Activity</Link> and can be undone there.
      </p>
    </div>
  );
}

// What the buffer draws from (#110): every category without a target of its
// own, each linking to its own page, where a target can be set up.
function Covers({ covers, view }: { covers: { categoryId: string; name: string; spentCents: number }[]; view: Parameters<typeof itemHref>[1] }) {
  const sorted = [...covers].sort((a, b) => b.spentCents - a.spentCents || a.name.localeCompare(b.name));
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">What the buffer covers</h2>
      <p className="text-xs text-muted-foreground">
        Every expense category without a target of its own or its parent&apos;s ({covers.length}). Open one to give it its own target.
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {sorted.map((c) => (
          <li key={c.categoryId}>
            <Link href={itemHref(c.categoryId, view)} className="flex justify-between gap-3 px-3 py-1.5 hover:bg-accent">
              <span className="truncate">{c.name}</span>
              <span className={`tabular-nums ${c.spentCents === 0 ? "text-muted-foreground" : ""}`}>{formatCents(c.spentCents)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
