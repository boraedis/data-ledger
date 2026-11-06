import Link from "next/link";
import { notFound } from "next/navigation";
import { periodBreakdown, type Share } from "@/lib/budgets/breakdown";
import { HISTORY_MONTHS } from "@/lib/budgets/engine";
import { historyLabel, suggestedTargetCents } from "@/lib/budgets/format";
import { budgetHref, budgetView, itemHref } from "@/lib/budgets/tabs";
import { versionSpans } from "@/lib/budgets/target-list";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import {
  ITEM_RANGES,
  backdateRange,
  budgetHistory,
  budgetStatus,
  itemAnalysis,
  listTargets,
  targetTransactions,
  yearlyCharges,
  type ItemRange,
} from "@/operations/budgets";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { MonthBars } from "../month-bars";
import { BudgetTabs } from "../tabs";
import { TargetSettings } from "./settings";
import { ItemStatus } from "./status";
import { privacyMode } from "@/lib/privacy/server";

// One budget item (#174): a category's target, or the buffer's, judged as
// a whole over time (#206) rather than a month at a time. This month and
// the year so far on top; then, over a range (the last 12 months by
// default, or 3, or the year to date), spend against the target month by
// month, what it usually costs, how often it went over, and its biggest
// charges, which is what deciding an amount needs. Then the target and
// every version of it (past ones editable through the backdate review),
// and this period's transactions. The Month view lists targets, and holds
// the per-period actions such as moving budget; this is where each target
// is set up.
//
// No month navigation and no day-by-day view: the Month view has both.
// /budgets/<category id> or /budgets/buffer, with ?range=3|ytd and the
// tabs' ?gross=1.

const RANGE_LABELS: Record<ItemRange, string> = { "3": "3 months", ytd: "Year to date", "12": "12 months" };
const isRange = (value: unknown): value is ItemRange => typeof value === "string" && (ITEM_RANGES as readonly string[]).includes(value);

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
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
  await privacyMode();
  const [{ target }, sp] = await Promise.all([props.params, props.searchParams]);
  if (target !== "buffer" && !/^[0-9a-f-]{36}$/.test(target)) notFound();
  const categoryId = target === "buffer" ? null : target;

  const today = new Date().toISOString().slice(0, 10);
  // Always as of today: the tabs' ?month= is for the Month and Year views,
  // and only carried through so going back keeps it.
  const view = budgetView(sp, today);
  const { gross } = view;
  const on = today;
  const range: ItemRange = isRange(sp.range) ? sp.range : "12";

  const db = getDb();
  const cats = await read(db, listCategories, {});
  const option = categoryOptions(cats).find((o) => o.id === categoryId);
  // Only expense categories take targets; anything else isn't a budget item.
  if (categoryId !== null && (!option || option.kind !== "expense")) notFound();
  const name = categoryId === null ? "Everything else (buffer)" : option!.label;

  const [status, versions, analysis, history, netHistory, yearly, backdate, txns] = await Promise.all([
    read(db, budgetStatus, { on, gross }),
    read(db, listTargets, {}),
    read(db, itemAnalysis, { categoryId, range, on, gross }),
    read(db, budgetHistory, { on, gross }),
    // Suggested amounts (#106) come from net spend: targets are net.
    gross ? read(db, budgetHistory, { on, gross: false }) : null,
    read(db, yearlyCharges, { on: today }),
    read(db, backdateRange, {}),
    read(db, targetTransactions, { categoryId, on, gross }),
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
  // A month's bar opens that month in the Month view, where its day by day is.
  const bars = analysis.months.map((m) => ({ ...m, href: budgetHref("/budgets/month", { ...view, month: m.month.slice(0, 7) }) }));
  const thisMonth = `${today.slice(0, 7)}-01`;
  const breakdown = txns ? periodBreakdown(txns.lines) : null;
  const rangeHref = (r: ItemRange) => {
    const base = itemHref(categoryId, view);
    return r === "12" ? base : `${base}${base.includes("?") ? "&" : "?"}range=${r}`;
  };
  const ytd = analysis.yearToDate;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={budgetHref("/budgets/month", view)} className="text-sm text-muted-foreground hover:text-foreground">
          ← Budgets
        </Link>
        <BudgetTabs current={null} view={view} />
      </div>
      <h1 className="text-2xl font-semibold">{name}</h1>

      {/* This period, in progress through its last day, as on the cards (#147), and the year so far. */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {t ? <ItemStatus t={t} inProgress /> : <p className="text-sm text-muted-foreground">No target in effect now.</p>}
        {ytd && ytd.targetCents > 0 ? (
          <section aria-label="Year to date" className="space-y-1 rounded-lg border p-3 text-sm">
            <h2 className="text-xs text-muted-foreground">{ytd.year} so far</h2>
            <p className="tabular-nums">
              <span className="text-lg font-medium">{formatCents(ytd.spentCents)}</span>{" "}
              <span className="text-muted-foreground">of {formatCents(ytd.targetCents)} for the year</span>
            </p>
            <p className={`text-xs tabular-nums ${ytd.remainingCents < 0 ? "text-destructive" : "text-muted-foreground"}`}>
              {ytd.remainingCents < 0 ? `${formatCents(-ytd.remainingCents)} over` : `${formatCents(ytd.remainingCents)} left`}
            </p>
          </section>
        ) : null}
      </div>

      <section className="space-y-3" aria-label="Spending over time">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Spending, {range === "ytd" ? "this year" : `last ${RANGE_LABELS[range]}`}</h2>
          <nav aria-label="Range" className="flex gap-1 text-sm">
            {ITEM_RANGES.map((r) => (
              <Link
                key={r}
                href={rangeHref(r)}
                aria-current={r === range ? "true" : undefined}
                className={`rounded-md px-2 py-0.5 ${r === range ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground"}`}
              >
                {RANGE_LABELS[r]}
              </Link>
            ))}
          </nav>
        </div>
        {bars.length ? (
          <>
            <MonthBars bars={bars} viewedMonth={thisMonth} partialMonth={thisMonth} />
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Average month" value={analysis.averageCents === null ? "—" : formatCents(analysis.averageCents)} />
              <Stat label="Typical month" value={analysis.typicalCents === null ? "—" : formatCents(analysis.typicalCents)} />
              <Stat label="Months over target" value={String(analysis.overMonths)} />
              <Stat label="Months at or under" value={String(analysis.underMonths)} />
            </dl>
            <p className="text-xs text-muted-foreground">
              {analysis.completeMonths
                ? `Average and typical (the middle month) over the ${analysis.completeMonths} complete ${analysis.completeMonths === 1 ? "month" : "months"} shown; this month counts toward over only once it is.`
                : "No complete month in this range yet: this month counts toward over only once it is."}{" "}
              Tap a month to open it in the Month view.
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
        {analysis.largest.length ? (
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Largest charges</h3>
            <ul className="divide-y rounded-lg border text-sm">
              {analysis.largest.map((l, i) => (
                <li key={`${l.transactionId}-${i}`}>
                  <Link href={`/transactions/${l.transactionId}`} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-accent">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{l.merchant ?? l.description}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {day(l.date)} · {l.accountName} · {l.categoryName}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatCents(l.spentCents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <TargetSettings
        categoryId={categoryId}
        name={name}
        current={inEffectNow}
        spans={spans}
        history={h}
        netHistory={net}
        windowMonths={HISTORY_MONTHS}
        backdate={backdate}
        yearly={yearly.filter((y) => y.categoryId === categoryId)}
      />

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
