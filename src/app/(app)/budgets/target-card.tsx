"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { historyLabel, periodLabel, scheduleLabel, type HistorySummary } from "@/lib/budgets/format";
import { formatCents } from "@/lib/money";
import { TargetForm } from "./forms";
import { MonthBars, type Bar } from "./month-bars";

export type CardTarget = {
  categoryId: string | null;
  name: string;
  start: string;
  end: string;
  periodMonths: number;
  targetCents: number;
  carryInCents: number;
  adjustmentsCents: number;
  availableCents: number;
  spentCents: number;
  remainingCents: number;
  rollover: boolean;
  sinkingFund: boolean;
  effectiveFrom: string;
  paceCents: number | null;
  setAsideMonthlyCents: number | null;
  setAsideByNowCents: number | null;
  // The version in effect, for editing.
  amountCents: number;
  anchorOn: string;
};

// One target's period: a bar of spent against available, an even-pace
// marker for multi-month periods, and the arithmetic spelled out so
// rollover and rebalancing never look like magic.
export function TargetCard({
  target: t,
  editable,
  history,
  netHistory,
  windowMonths,
  bars,
  viewedMonth,
  partialMonth,
}: {
  target: CardTarget;
  editable: boolean;
  history?: HistorySummary;
  // Net, for suggesting an amount (#106); see TargetForm.
  netHistory?: HistorySummary;
  windowMonths: number;
  bars: Bar[];
  viewedMonth: string;
  partialMonth: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const over = t.remainingCents < 0;
  const scale = Math.max(t.availableCents, t.spentCents, 1);
  const spentWidth = (Math.max(0, t.spentCents) / scale) * 100;
  const paceAt = t.paceCents !== null && t.availableCents > 0 ? (t.paceCents / scale) * 100 : null;
  const parts = [
    `target ${formatCents(t.targetCents)}`,
    t.carryInCents ? `${t.carryInCents > 0 ? "+" : "−"}${formatCents(Math.abs(t.carryInCents))} rolled over` : null,
    t.adjustmentsCents ? `${t.adjustmentsCents > 0 ? "+" : "−"}${formatCents(Math.abs(t.adjustmentsCents))} moved` : null,
  ].filter(Boolean);

  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 font-medium">
          {t.name}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {periodLabel(t.start, t.end)} · {scheduleLabel(t.periodMonths)}
            {t.rollover ? " · rolls over" : ""}
          </span>
        </span>
        <span className="tabular-nums">
          {formatCents(t.spentCents)} <span className="text-muted-foreground">of {formatCents(t.availableCents)}</span>
        </span>
      </div>

      <div className="relative h-2.5 rounded-sm bg-muted" aria-hidden>
        <div
          className={`h-full rounded-sm ${over ? "bg-negative/80" : "bg-primary"}`}
          style={{ width: `${spentWidth}%` }}
        />
        {over && t.availableCents > 0 ? (
          // When over, the bar is scaled to what was spent; this tick marks
          // where the limit was.
          <div className="absolute -top-1 h-4.5 w-0.5 bg-foreground" style={{ left: `calc(${(t.availableCents / scale) * 100}% - 1px)` }} />
        ) : null}
        {paceAt !== null ? (
          // Where spending would be today at an even pace through the period.
          <div className="absolute -top-1 h-4.5 w-0.5 bg-warning" style={{ left: `calc(${Math.min(paceAt, 100)}% - 1px)` }} />
        ) : null}
      </div>

      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span>{parts.join(" ")}</span>
        <span className={over ? "font-medium text-negative" : ""}>
          {over ? `${formatCents(-t.remainingCents)} over` : `${formatCents(t.remainingCents)} left`}
        </span>
      </div>
      {t.paceCents !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="mr-1 inline-block h-2 w-0.5 bg-warning align-middle" aria-hidden />
          Even pace to date: {formatCents(t.paceCents)} ({t.spentCents <= t.paceCents ? "under" : "ahead of"} pace)
          {t.setAsideMonthlyCents !== null
            ? ` · Set aside ${formatCents(t.setAsideMonthlyCents)}/month; ${formatCents(t.setAsideByNowCents ?? 0)} by now`
            : ""}
        </p>
      ) : null}

      <MonthBars bars={bars} viewedMonth={viewedMonth} partialMonth={partialMonth} />
      <p className="text-xs text-muted-foreground tabular-nums">{historyLabel(history, windowMonths)}</p>

      {editable ? (
        editing ? (
          <div className="border-t pt-3">
            <TargetForm
              initial={{
                categoryId: t.categoryId,
                name: t.name,
                amountCents: t.amountCents,
                periodMonths: t.periodMonths,
                anchorOn: t.anchorOn,
                rollover: t.rollover,
                sinkingFund: t.sinkingFund,
              }}
              histories={history ? { [t.categoryId ?? ""]: history } : {}}
              suggestFrom={netHistory ? { [t.categoryId ?? ""]: netHistory } : {}}
              windowMonths={windowMonths}
              onDone={() => setEditing(false)}
            />
          </div>
        ) : (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)}>
            Edit target
          </Button>
        )
      ) : null}
    </li>
  );
}
