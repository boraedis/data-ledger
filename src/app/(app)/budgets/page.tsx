import Link from "next/link";
import { HISTORY_MONTHS } from "@/lib/budgets/engine";
import { budgetHref, budgetView, itemHref } from "@/lib/budgets/tabs";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { backdateRange, budgetHistory, budgetPay, budgetStatus, yearlyCharges } from "@/operations/budgets";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { AddTarget } from "./add-target";
import type { TargetChoice } from "./forms";
import { BudgetOverview } from "./overview";
import { PayStrip } from "./pay-strip";
import { BudgetTabs } from "./tabs";

// Budgets (#7), the Month view: how the month is going. Every target once,
// one row each with its bar, coloured by pace (#159), and spent of
// available (#174). A row opens the target's own page, where it's analysed
// and changed; adding a target opens in place at the top. Then pay against
// the budget (#128), and spending without a target when there's no buffer.
// ?month=YYYY-MM looks at an earlier month as it stood then — targets are
// versioned, so a past month shows the target it had.

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

export default async function BudgetsPage(props: PageProps<"/budgets">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  // Net by default (your share of shared expenses); ?gross=1 shows spending
  // as charged, before what friends owe comes off.
  const { month, thisMonth, gross } = view;
  const isCurrent = month === thisMonth;
  // A past month is shown as of its last day.
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

  const db = getDb();
  const [status, payVsBudget, adding] = await Promise.all([
    read(db, budgetStatus, { on, gross }),
    // Pay against the month's budget (#128).
    read(db, budgetPay, { on, gross }),
    // Adding a target only on this month: what the form needs.
    isCurrent
      ? Promise.all([
          read(db, listCategories, {}),
          // Suggested amounts (#106) come from net spend, since targets are net.
          read(db, budgetHistory, { on, gross: false }),
          read(db, yearlyCharges, { on }),
          read(db, backdateRange, {}),
        ])
      : null,
  ]);
  const href = (next: { month?: string; gross?: boolean }) => budgetHref("/budgets", { ...view, month: next.month ?? month, gross: next.gross ?? gross });

  const add = (() => {
    if (!adding) return null;
    const [cats, history, yearly, range] = adding;
    const targeted = new Set(status.targets.map((t) => t.categoryId));
    const choices: TargetChoice[] = [
      ...(targeted.has(null) ? [] : [{ categoryId: null, name: "Everything else (buffer)" }]),
      ...categoryOptions(cats)
        .filter((o) => o.kind === "expense" && !targeted.has(o.id))
        .map((o) => ({ categoryId: o.id, name: o.label })),
    ];
    const histories = Object.fromEntries(
      history.map((h) => [h.categoryId ?? "", { averageCents: h.averageCents, months: h.months, overMonths: h.overMonths, comparedMonths: h.comparedMonths }]),
    );
    return { choices, histories, yearly: yearly.filter((y) => choices.some((c) => c.categoryId === y.categoryId)), range };
  })();
  const buffer = status.targets.find((t) => t.categoryId === null);
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Budgets</h1>
        <BudgetTabs current="month" view={view} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Month" className="flex items-center gap-3 text-sm">
          <Link href={href({ month: shiftMonth(month, -1) })} className="text-muted-foreground hover:text-foreground">
            ← Earlier
          </Link>
          <span className="font-medium">{monthLabel}</span>
          {isCurrent ? null : (
            <Link href={href({ month: shiftMonth(month, 1) })} className="text-muted-foreground hover:text-foreground">
              Later →
            </Link>
          )}
        </nav>
        <span className="text-xs text-muted-foreground">
          {gross ? "Gross spending. " : "Your share of shared expenses. "}
          <Link href={href({ gross: !gross })} className="underline">
            {gross ? "Show your share" : "Show gross"}
          </Link>
        </span>
      </div>

      {add ? (
        <AddTarget
          choices={add.choices}
          histories={add.histories}
          suggestFrom={add.histories}
          windowMonths={HISTORY_MONTHS}
          yearly={add.yearly}
          backdate={add.range}
        />
      ) : null}

      {status.targets.length === 0 ? (
        <p className="text-muted-foreground">
          No targets {isCurrent ? "yet" : "in effect then"}. A good start: a buffer for everything, then targets for the few
          categories you actually want to watch.
        </p>
      ) : (
        <>
          <BudgetOverview
            view={view}
            inProgress={isCurrent}
            targets={status.targets.map((t) => ({
              categoryId: t.categoryId,
              name: t.name,
              start: t.start,
              end: t.end,
              spentCents: t.spentCents,
              availableCents: t.availableCents,
              remainingCents: t.remainingCents,
              elapsedShare: t.elapsedShare,
              projectedCents: t.projectedCents,
            }))}
          />
          <PayStrip
            summary={payVsBudget.summary}
            pay={payVsBudget.pay}
            typical={payVsBudget.typical}
            landedDifferenceCents={payVsBudget.landedDifferenceCents}
            isCurrent={isCurrent}
            uncategorized={payVsBudget.uncategorized}
          />
        </>
      )}

      {/* With a buffer, its page lists what it covers (#110). */}
      {!buffer && status.unbudgeted.byCategory.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Spending without a target</h2>
          <p className="text-xs text-muted-foreground">
            By category this month. Something that shows up here every month may deserve its own target; a buffer
            target (&ldquo;Everything else&rdquo;) would give all of it one shared limit.
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {status.unbudgeted.byCategory.map((c) => (
              <li key={c.categoryId}>
                {/* Its page sets up a target (#174). */}
                <Link href={itemHref(c.categoryId, view)} className="flex justify-between gap-3 px-3 py-1.5 hover:bg-muted/50">
                  <span className="truncate">{c.name}</span>
                  <span className="tabular-nums">{formatCents(c.spentCents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Net spending in accounts that count toward budgets: refunds offset it; transfers, income and investment accounts never count.
        {isCurrent ? "" : ` ${monthLabel} as of its last day, with the targets in effect then.`} Every change is in{" "}
        <Link href="/activity" className="underline">
          Activity
        </Link>{" "}
        and can be undone there.
      </p>
    </div>
  );
}
