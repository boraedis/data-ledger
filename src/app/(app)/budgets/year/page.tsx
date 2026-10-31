import Link from "next/link";
import { getDb } from "@/lib/db";
import { budgetView } from "@/lib/budgets/tabs";
import { gridSegments, segmentFigures, yearTotals } from "@/lib/budgets/year";
import { budgetMonthly, budgetPayYear } from "@/operations/budgets";
import { read } from "@/operations/runtime";
import { YearGrid, type GridColumn, type GridRow } from "./grid";
import { BudgetTabs } from "../tabs";
import { PayYear } from "./pay-year";

// Every target's spend against target, month by month (#108): one row per
// target (the buffer first), one column per month for the last 12, so a
// pattern across categories shows at a glance. ?month=YYYY-MM is the last
// column; ?gross=1 as on Budgets.
//
// Each cell is what budgets.status counted toward that target that month,
// against the version in effect then, so a past month keeps the target it
// had. Targets that have since ended keep their row. The whole grid comes
// from one budgets.monthly read: one query for the window's lines, not one
// per cell.
//
// A real table, so screen readers get rows and columns. It's sized to fit a
// phone: on a narrow screen cells are color only (each still has a label,
// and each row says how many months went over), and amounts appear where
// there's room for them.

const MONTHS = 12;

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

const monthName = (month: string, style: "narrow" | "short" | "long") =>
  new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: style,
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

export default async function BudgetYearPage(props: PageProps<"/budgets/year">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  const { month, thisMonth } = view;
  const isCurrent = month === thisMonth;
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const gross = view.gross;

  // One-time stubs (bonuses) count unless ?bonus=0 leaves them out (#138).
  const includeOneTime = sp.bonus !== "0";
  const db = getDb();
  const payYear = await read(db, budgetPayYear, { on, gross, months: MONTHS, includeOneTime });
  const rows = (await read(db, budgetMonthly, { on, gross, months: MONTHS, includeEnded: true, details: true })).sort((a, b) =>
    a.categoryId === null ? -1 : b.categoryId === null ? 1 : a.name.localeCompare(b.name),
  );
  const columns = rows[0]?.months.map((m) => m.month) ?? Array.from({ length: MONTHS }, (_, i) => `${shiftMonth(month, i - MONTHS + 1)}-01`);
  const partial = isCurrent ? `${month}-01` : null;
  // Each target's 12 months, each month across targets, and the grid (#124).
  const totals = yearTotals(rows);

  const href = (path: "/budgets" | "/budgets/year", next: { month?: string; gross?: boolean; bonus?: boolean }) => {
    const q = new URLSearchParams();
    const m = next.month ?? month;
    if (m !== thisMonth) q.set("month", m);
    if (next.gross ?? gross) q.set("gross", "1");
    if (path === "/budgets/year" && !(next.bonus ?? includeOneTime)) q.set("bonus", "0");
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  const later = shiftMonth(month, MONTHS) > thisMonth ? thisMonth : shiftMonth(month, MONTHS);

  // What the grid and its tooltips (#139) need, links worked out here.
  const transactionsHref = (categoryId: string | null, m: string) => {
    const q = new URLSearchParams({ target: categoryId ?? "buffer" });
    if (m.slice(0, 7) !== thisMonth) q.set("month", m.slice(0, 7));
    if (gross) q.set("gross", "1");
    return `/budgets/transactions?${q}`;
  };
  const gridRows: GridRow[] = rows.map((r, ri) => {
    // A quarterly or annual target counts once per period, not per month (#157).
    const targeted = gridSegments(r.months).flatMap((s) => segmentFigures(s) ?? []);
    return {
      key: r.categoryId ?? "buffer",
      name: r.name,
      isBuffer: r.categoryId === null,
      total: totals.byRow[ri],
      targeted: targeted.length,
      over: targeted.filter((m) => m.spentCents > m.targetCents).length,
      months: r.months.map((m) => ({
        ...m,
        href: href("/budgets", { month: m.month.slice(0, 7) }),
        transactionsHref: m.targetCents === null ? null : transactionsHref(r.categoryId, m.month),
      })),
    };
  });
  const gridColumns: GridColumn[] = columns.map((c, i) => {
    const cells = rows.map((r) => r.months[i]).filter((m) => m.targetCents !== null);
    return {
      month: c,
      href: href("/budgets", { month: c.slice(0, 7) }),
      total: totals.byColumn[i],
      targets: cells.length,
      over: cells.filter((m) => m.spentCents > m.targetCents!).length,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Budgets by month</h1>
        <BudgetTabs current="year" view={view} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <nav aria-label="Months" className="flex items-center gap-3 text-sm">
          <Link href={href("/budgets/year", { month: shiftMonth(month, -MONTHS) })} className="text-muted-foreground hover:text-foreground">
            ← Earlier
          </Link>
          <span className="font-medium">
            {monthName(columns[0], "long")} – {monthName(columns.at(-1)!, "long")}
          </span>
          {isCurrent ? null : (
            <Link href={href("/budgets/year", { month: later })} className="text-muted-foreground hover:text-foreground">
              Later →
            </Link>
          )}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        Each target&apos;s spending against the target it had that month: green under, red over, deeper the further off (yellow while still in progress: ahead of pace but under), with the amount over (+) or under (−) where there&apos;s room.
        A quarterly or annual target is one box per period, spanning its months, against the period&apos;s target; in the totals it counts at its even monthly share, so months add up. Totals add up only the months that had a target. Tap a month to open it.{" "}
        {gross ? (
          <>
            Showing gross spending.{" "}
            <Link href={href("/budgets/year", { gross: false })} className="underline">
              Show your share
            </Link>
          </>
        ) : (
          <>
            Shared expenses count only your share.{" "}
            <Link href={href("/budgets/year", { gross: true })} className="underline">
              Show gross
            </Link>
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No targets in effect in these months.</p>
      ) : (
        <>
          <PayYear
            summary={payYear.summary}
            monthsWithoutPay={payYear.monthsWithoutPay}
            isCurrent={isCurrent}
            oneTimeCount={payYear.oneTimeCount}
            oneTimeLeftOut={payYear.oneTimeLeftOut}
            toggleOneTimeHref={href("/budgets/year", { bonus: !includeOneTime })}
          />
          <YearGrid
            rows={gridRows}
            columns={gridColumns}
            grand={totals.total}
            viewedMonth={month}
            partial={partial}
            asOf={on}
            pay={payYear.months.map((m) => ({ month: m.month, payCents: m.payCents, savedCents: m.savedCents }))}
            payTotals={payYear.summary ? { netPayCents: payYear.totals.netPayCents, savedCents: payYear.summary.actualSaving.cents } : null}
          />
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          Under
          <span className="size-3 rounded-sm bg-positive/45" aria-hidden />
          <span className="size-3 rounded-sm bg-positive/30" aria-hidden />
          <span className="size-3 rounded-sm bg-positive/15" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/20" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/40" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/60" aria-hidden />
          Over
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-warning/50" aria-hidden />
          Ahead of pace, still under
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-muted/50" aria-hidden />
          No target that month
        </span>
        {partial ? (
          <span className="flex items-center gap-1">
            <span className="size-3 rounded-sm outline-1 -outline-offset-2 outline-dashed outline-foreground/40" aria-hidden />
            So far this month
          </span>
        ) : null}
      </div>
    </div>
  );
}
