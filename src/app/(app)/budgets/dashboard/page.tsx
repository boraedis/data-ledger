import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { budgetDashboard, type Overspend } from "@/lib/budgets/dashboard";
import { budgetHref, budgetView, itemHref } from "@/lib/budgets/tabs";
import type { YearTotal } from "@/lib/budgets/year";
import { budgetMonthly, budgetPay, budgetPayYear } from "@/operations/budgets";
import { read } from "@/operations/runtime";
import type { Summary } from "../pay-strip";
import { BudgetTabs } from "../tabs";

// The budgets dashboard (#146): how the month and the year so far are going,
// and the biggest overspends in each, linking into the Month and Year views.
// ?month= picks the month (and so the year, January to that month); ?gross=1
// as on the other tabs. The figures are the Year view's, so they agree with
// it; see lib/budgets/dashboard.ts for why the month can differ from the
// Month view's total.
//
// Each box also has its pay line (from budgets.pay and budgets.payYear, the
// Month and Year strips' figures). It's a separate line, not mixed into the
// totals above it: pay compares all spending with net pay, and the year
// counts only months with pay, so its figures follow their own rules.

const monthName = (month: string, withYear = true) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

const ofPay = (f: { percent: number | null }) => (f.percent === null ? "" : ` (${f.percent}%)`);

function PayLine({ summary, basis, none }: { summary: Summary | null; basis: string; none: string }) {
  if (!summary) return <p className="border-t pt-2 text-xs text-muted-foreground">{none}</p>;
  const saved = summary.actualSaving.cents;
  return (
    <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
      <p>
        Net pay <span className="font-medium text-foreground tabular-nums">{formatCents(summary.netPay.cents)}</span> {basis}
      </p>
      <p className="tabular-nums">
        {summary.targets.percent !== null && summary.spent.percent !== null
          ? `Of pay: targets ${summary.targets.percent}%, spent ${summary.spent.percent}%. `
          : ""}
        Expected saving {formatCents(summary.expectedSaving.cents)}
        {ofPay(summary.expectedSaving)},{" "}
        <span className={saved < 0 ? "text-negative" : "text-positive"}>
          {saved < 0 ? `${formatCents(-saved)} more spent than paid` : `saved ${formatCents(saved)}${ofPay(summary.actualSaving)}`}
        </span>
      </p>
    </div>
  );
}

function Totals({
  title,
  total,
  partial,
  empty,
  pay,
}: {
  title: string;
  total: YearTotal | null;
  partial: boolean;
  empty: React.ReactNode;
  pay: React.ReactNode;
}) {
  if (!total) {
    return (
      <section className="space-y-1 rounded-lg border p-3">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{empty}</p>
        {pay}
      </section>
    );
  }
  const diff = total.targetCents - total.spentCents;
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h2 className="font-medium">{title}</h2>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Targets</dt>
          <dd className="text-lg font-semibold tabular-nums">{formatCents(total.targetCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Spent{partial ? " so far" : ""}</dt>
          <dd className="text-lg font-semibold tabular-nums">{formatCents(total.spentCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{diff < 0 ? "Over" : "Under"}</dt>
          <dd className={`text-lg font-semibold tabular-nums ${diff < 0 ? "text-negative" : "text-positive"}`}>{formatCents(Math.abs(diff))}</dd>
        </div>
      </dl>
      {pay}
    </section>
  );
}

function Overspends({ title, items, href, none }: { title: string; items: Overspend[]; href: (categoryId: string | null) => string; none: string }) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{none}</p>
      ) : (
        <ol className="divide-y rounded-lg border text-sm">
          {items.map((o) => (
            <li key={o.categoryId ?? "buffer"}>
              <Link href={href(o.categoryId)} className="flex items-baseline justify-between gap-3 px-3 py-2 hover:bg-accent">
                <span className="min-w-0 truncate">{o.name}</span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="text-negative">{formatCents(o.overCents)} over</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {formatCents(o.spentCents)} of {formatCents(o.targetCents)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default async function BudgetDashboardPage(props: PageProps<"/budgets/dashboard">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  const { month, thisMonth, gross } = view;
  const isCurrent = month === thisMonth;
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const year = month.slice(0, 4);

  // January through the month shown; targets ended since still count for
  // the months they had.
  const db = getDb();
  const months = Number(month.slice(5, 7));
  const [rows, pay, payYear] = await Promise.all([
    read(db, budgetMonthly, { on, gross, months, includeEnded: true, moved: true }),
    read(db, budgetPay, { on, gross }),
    read(db, budgetPayYear, { on, gross, months }),
  ]);
  const d = budgetDashboard(rows);

  const targetsHref = budgetHref("/budgets/targets", view);
  // A month's overspend opens its target's page (#174); a year's, its row on the Year view
  // ending in that month.
  const cardHref = (categoryId: string | null) => itemHref(categoryId, view);
  const rowHref = (categoryId: string | null) => `${budgetHref("/budgets/year", view)}#year-${categoryId ?? "buffer"}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Budgets</h1>
        <BudgetTabs current="dashboard" view={view} />
      </div>
      <p className="text-sm text-muted-foreground">
        {gross ? "Gross spending, as charged." : "Your share of shared expenses."} A target over several months counts at its even
        monthly share, as on the <Link href={budgetHref("/budgets/year", view)} className="underline">Year view</Link>, and only months
        with a target count toward the totals.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <Totals
            title={monthName(month)}
            total={d.month}
            partial={isCurrent}
            pay={
              <PayLine
                summary={pay.summary}
                basis={pay.typical ? "(a typical month, as on the Month view)" : "(what landed)"}
                none="No pay recorded this month."
              />
            }
            empty={
              <>
                No targets {isCurrent ? "yet" : "in effect then"}.{" "}
                <Link href={targetsHref} className="underline">
                  Add a target
                </Link>{" "}
                to see the month here.
              </>
            }
          />
          {d.month ? (
            <Overspends title="Biggest overspends this month" items={d.monthOver} href={cardHref} none="Nothing over target." />
          ) : null}
          <Link href={budgetHref("/budgets", view)} className="block text-sm underline">
            Open {monthName(month, false)} →
          </Link>
        </div>
        <div className="space-y-4">
          <Totals
            title={`${year}${isCurrent ? " so far" : ` through ${monthName(month, false)}`}`}
            total={d.year}
            partial={isCurrent}
            pay={
              <PayLine
                summary={payYear.summary}
                basis={`(what landed${payYear.monthsWithoutPay ? `; ${payYear.monthsWithoutPay} ${payYear.monthsWithoutPay === 1 ? "month" : "months"} with no pay left out` : ""})`}
                none="No pay recorded this year."
              />
            }
            empty={
              <>
                No targets this year{isCurrent ? " yet" : ""}.{" "}
                <Link href={targetsHref} className="underline">
                  Add a target
                </Link>
              </>
            }
          />
          {d.year ? (
            <Overspends title={`Biggest overspends in ${year}`} items={d.yearOver} href={rowHref} none="Nothing over target." />
          ) : null}
          <Link href={budgetHref("/budgets/year", view)} className="block text-sm underline">
            Open the Year view →
          </Link>
        </div>
      </div>
    </div>
  );
}
