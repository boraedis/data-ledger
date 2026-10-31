import Link from "next/link";
import { budgetOverview, type OverviewRow, type OverviewTarget } from "@/lib/budgets/overview";
import { periodLabel } from "@/lib/budgets/format";
import { paceFor } from "@/lib/budgets/pace-colour";
import { itemHref, type BudgetView } from "@/lib/budgets/tabs";
import { formatCents } from "@/lib/money";
import { PaceBar } from "./pace-bar";

// The Month view's list (#122, #174): every target once, each row its bar,
// spent of available, and left or over, and a link to the target's own
// page, where the detail and the changes are. Server-rendered.

function Row({ row, period, view, inProgress }: { row: OverviewRow; period?: string; view: BudgetView; inProgress: boolean }) {
  const over = row.remainingCents < 0;
  // Still under, but heading over at this pace (#147).
  const projectedOver =
    inProgress && !over && row.projectedCents != null && row.projectedCents > row.availableCents ? row.projectedCents - row.availableCents : null;
  return (
    <li>
      <Link
        href={itemHref(row.categoryId, view)}
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-muted/50"
      >
        <span className="truncate font-medium">
          {row.name}
          {period ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{period}</span> : null}
        </span>
        <span className="text-right tabular-nums">
          {formatCents(row.spentCents)} <span className="text-muted-foreground">of {formatCents(row.availableCents)}</span>
        </span>
        {/* The row opens the target's page. */}
        <span aria-hidden className="row-span-2 text-muted-foreground">
          ›
        </span>
        {/* Coloured by pace while the period is in progress (#159). */}
        <PaceBar
          spentCents={row.spentCents}
          budgetCents={row.availableCents}
          paceCents={row.availableCents > 0 ? paceFor(row.availableCents, row.elapsedShare) : null}
          className="h-1.5"
          rounded="rounded-full"
        />
        <span className={`text-right text-xs tabular-nums ${over ? "font-medium text-negative" : "text-muted-foreground"}`}>
          {over ? `${formatCents(-row.remainingCents)} over` : `${formatCents(row.remainingCents)} left`}
          {projectedOver !== null ? <span className="text-negative"> · heading {formatCents(projectedOver)} over</span> : null}
        </span>
      </Link>
    </li>
  );
}

export function BudgetOverview({ targets, view, inProgress }: { targets: OverviewTarget[]; view: BudgetView; inProgress: boolean }) {
  const { monthly, longer, total } = budgetOverview(targets);
  return (
    <section className="space-y-2" aria-label="This month">
      <ul className="divide-y rounded-lg border text-sm">
        {monthly.map((r) => (
          <Row key={r.categoryId ?? "buffer"} row={r} view={view} inProgress={inProgress} />
        ))}
        {total ? (
          <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 bg-muted/40 px-3 py-2 font-medium">
            <span>Total this month</span>
            <span className="text-right tabular-nums">
              {formatCents(total.spentCents)} <span className="font-normal text-muted-foreground">of {formatCents(total.availableCents)}</span>
            </span>
            <span aria-hidden className="invisible row-span-2">
              ›
            </span>
            <span />
            <span className={`text-right text-xs tabular-nums ${total.remainingCents < 0 ? "text-negative" : "font-normal text-muted-foreground"}`}>
              {total.remainingCents < 0 ? `${formatCents(-total.remainingCents)} over` : `${formatCents(total.remainingCents)} left`}
            </span>
          </li>
        ) : null}
        {longer.map((r) => (
          <Row key={r.categoryId ?? "buffer"} row={r} period={periodLabel(r.start, r.end)} view={view} inProgress={inProgress} />
        ))}
      </ul>
      {longer.length && total ? (
        <p className="text-xs text-muted-foreground">
          Targets over a longer period are listed below the total with their own period: a year&apos;s budget and spending since it began don&apos;t
          add up with a month&apos;s.
        </p>
      ) : null}
    </section>
  );
}
