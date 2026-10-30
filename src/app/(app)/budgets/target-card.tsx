"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { historyLabel, periodLabel, scheduleLabel, type HistorySummary } from "@/lib/budgets/format";
import { targetAnchor } from "@/lib/budgets/overview";
import { formatCents } from "@/lib/money";
import { TargetForm } from "./forms";
import { MonthBars, type Bar } from "./month-bars";
import { OPEN_TARGET } from "./overview";

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
// rollover and rebalancing never look like magic. Collapsed to that summary
// by default (#122), so the month fits on a screen; the detail (pace, the
// buffer's breakdown, the month bars, history, Edit) opens from the header,
// or from the overview's link to it.
export function TargetCard({
  target: t,
  editable,
  history,
  netHistory,
  windowMonths,
  bars,
  viewedMonth,
  partialMonth,
  covers,
  backdate,
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
  // The buffer's card only: every category it covers, with this period's spend (#110).
  covers?: { categoryId: string; name: string; spentCents: number }[];
  backdate?: { earliestMonth: string | null; currentMonth: string };
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const anchor = targetAnchor(t.categoryId);
  // Opened by an overview link, or arriving with its #anchor in the URL.
  // Scrolled to once it has opened, so it lands on the card's new height.
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (revealed) ref.current?.scrollIntoView({ block: "start" });
  }, [revealed]);
  useEffect(() => {
    const reveal = () => {
      setOpen(true);
      setRevealed((n) => n + 1);
    };
    if (window.location.hash === `#${anchor}`) reveal();
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === anchor) reveal();
    };
    window.addEventListener(OPEN_TARGET, onOpen);
    return () => window.removeEventListener(OPEN_TARGET, onOpen);
  }, [anchor]);
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
    <li id={anchor} ref={ref} className="scroll-mt-4 space-y-2 rounded-lg border p-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={`${anchor}-detail`}
        className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-left"
      >
        <span className="min-w-0 font-medium">
          <span aria-hidden className={`mr-1.5 inline-block text-xs text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
          {t.name}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {periodLabel(t.start, t.end)} · {scheduleLabel(t.periodMonths)}
            {t.rollover ? " · rolls over" : ""}
          </span>
        </span>
        <span className="tabular-nums">
          {formatCents(t.spentCents)} <span className="text-muted-foreground">of {formatCents(t.availableCents)}</span>
        </span>
      </button>

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
      {open || editing ? (
        <div id={`${anchor}-detail`} className="space-y-2">
          {t.paceCents !== null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              <span className="mr-1 inline-block h-2 w-0.5 bg-warning align-middle" aria-hidden />
              Even pace to date: {formatCents(t.paceCents)} ({t.spentCents <= t.paceCents ? "under" : "ahead of"} pace)
              {t.setAsideMonthlyCents !== null
                ? ` · Set aside ${formatCents(t.setAsideMonthlyCents)}/month; ${formatCents(t.setAsideByNowCents ?? 0)} by now`
                : ""}
            </p>
          ) : null}

          {covers ? <BufferCovers covers={covers} /> : null}
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
                  backdate={backdate}
                  onDone={() => setEditing(false)}
                />
              </div>
            ) : (
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)}>
                Edit target
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// What the buffer draws from (#110): categories with spending this period in
// view, the ones with nothing yet folded away, and a total that is the
// card's spent figure.
function BufferCovers({ covers }: { covers: { categoryId: string; name: string; spentCents: number }[] }) {
  const spending = covers.filter((c) => c.spentCents !== 0).sort((a, b) => b.spentCents - a.spentCents);
  const quiet = covers.filter((c) => c.spentCents === 0).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p>
        Covers every expense category without a target of its own or its parent&apos;s ({covers.length}). Spending in them
        counts here; give a category its own target to take it out.
      </p>
      {spending.length ? (
        <ul className="divide-y rounded-md border text-sm text-foreground">
          {spending.map((c) => (
            <li key={c.categoryId} className="flex justify-between gap-3 px-2 py-1">
              <span className="truncate">{c.name}</span>
              <span className="tabular-nums">{formatCents(c.spentCents)}</span>
            </li>
          ))}
          <li className="flex justify-between gap-3 px-2 py-1 font-medium">
            <span>Spent from the buffer</span>
            <span className="tabular-nums">{formatCents(spending.reduce((sum, c) => sum + c.spentCents, 0))}</span>
          </li>
        </ul>
      ) : null}
      {quiet.length ? (
        <details>
          <summary className="cursor-pointer hover:text-foreground">
            {quiet.length} more with nothing spent this period
          </summary>
          <p className="mt-1">{quiet.map((c) => c.name).join(" · ")}</p>
        </details>
      ) : null}
    </div>
  );
}
