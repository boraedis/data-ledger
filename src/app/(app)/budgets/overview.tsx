"use client";

import { budgetOverview, type OverviewRow, type OverviewTarget } from "@/lib/budgets/overview";
import { periodLabel } from "@/lib/budgets/format";
import { paceFor } from "@/lib/budgets/pace-colour";
import { formatCents } from "@/lib/money";
import { PaceBar } from "./pace-bar";

// The month at a glance (#122): every target on one screen, each row a link
// that opens its card below and scrolls to it. The card listens for
// OPEN_TARGET; the plain #anchor is there for opening in a new tab.

export const OPEN_TARGET = "budgets:open-target";

function open(anchor: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TARGET, { detail: anchor }));
  history.replaceState(null, "", `#${anchor}`);
}

function Row({ row, period }: { row: OverviewRow; period?: string }) {
  const over = row.remainingCents < 0;
  return (
    <li>
      <a
        href={`#${row.anchor}`}
        onClick={(e) => {
          e.preventDefault();
          open(row.anchor);
        }}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 hover:bg-muted/50"
      >
        <span className="truncate">
          {row.name}
          {period ? <span className="ml-1.5 text-xs text-muted-foreground">{period}</span> : null}
        </span>
        <span className="text-right tabular-nums">
          {formatCents(row.spentCents)} <span className="text-muted-foreground">of {formatCents(row.availableCents)}</span>
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
        </span>
      </a>
    </li>
  );
}

export function BudgetOverview({ targets }: { targets: OverviewTarget[] }) {
  const { monthly, longer, total } = budgetOverview(targets);
  return (
    <section className="space-y-2" aria-label="This month at a glance">
      <ul className="divide-y rounded-lg border text-sm">
        {monthly.map((r) => (
          <Row key={r.anchor} row={r} />
        ))}
        {total ? (
          <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 bg-muted/40 px-3 py-1.5 font-medium">
            <span>Total this month</span>
            <span className="text-right tabular-nums">
              {formatCents(total.spentCents)} <span className="font-normal text-muted-foreground">of {formatCents(total.availableCents)}</span>
            </span>
            <span />
            <span className={`text-right text-xs tabular-nums ${total.remainingCents < 0 ? "text-negative" : "font-normal text-muted-foreground"}`}>
              {total.remainingCents < 0 ? `${formatCents(-total.remainingCents)} over` : `${formatCents(total.remainingCents)} left`}
            </span>
          </li>
        ) : null}
        {longer.map((r) => (
          <Row key={r.anchor} row={r} period={periodLabel(r.start, r.end)} />
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
