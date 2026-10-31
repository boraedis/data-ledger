"use client";

import { useState } from "react";
import type { BurndownDay, CalendarDay } from "@/lib/budgets/burndown";
import { formatCents } from "@/lib/money";

// A budget period day by day (#149): the burndown and the spending calendar.
//
// The burndown is one axis (money left) with three lines: this period's
// actual, the straight line from the full amount to zero, and what a typical
// past period had left by the same day. Series are told apart by line style
// as well as weight, with a legend; status colours stay for the calendar.
// Hovering (or tapping) a day reads out all three; a text summary carries
// the same for screen readers.

const dayLabel = (date: string, withWeekday = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { ...(withWeekday ? { weekday: "short" } : {}), month: "short", day: "numeric", timeZone: "UTC" });

export function Burndown({
  days,
  availableCents,
  pastPeriods,
  height = 180,
  title,
}: {
  days: BurndownDay[];
  availableCents: number;
  pastPeriods: number;
  height?: number;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const pad = { top: 18, right: 8, bottom: 18, left: 8 };
  const lefts = days.flatMap((d) => (d.leftCents === null ? [] : [d.leftCents]));
  const typicals = days.flatMap((d) => (d.typicalCents === null ? [] : [d.typicalCents]));
  const top = Math.max(availableCents, ...lefts, ...typicals, 1);
  const bottom = Math.min(0, ...lefts, ...typicals);
  const x = (i: number) => pad.left + (days.length > 1 ? (i / (days.length - 1)) * (W - pad.left - pad.right) : 0);
  const y = (cents: number) => pad.top + ((top - cents) / (top - bottom)) * (height - pad.top - pad.bottom);
  const path = (values: (number | null)[]) =>
    values.reduce<string>((d, v, i) => (v === null ? d : `${d}${d === "" || values[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  // The straight line starts from the full amount, before the first day.
  const ideal = `M${x(0).toFixed(1)},${y(availableCents).toFixed(1)}${path(days.map((d) => d.idealCents)).replace(/^M/, "L")}`;
  const lastActual = days.findLastIndex((d) => d.leftCents !== null);
  const shown = hover ?? lastActual;
  const at = shown >= 0 ? days[shown] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    const i = Math.round(((ratio * W - pad.left) / (W - pad.left - pad.right)) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  return (
    <figure className="space-y-1.5">
      <figcaption className="sr-only">
        {title}.{" "}
        {at && at.leftCents !== null
          ? `${dayLabel(at.date)}: ${at.leftCents < 0 ? `${formatCents(-at.leftCents)} over` : `${formatCents(at.leftCents)} left`}, against ${formatCents(at.idealCents)} on a straight line${
              at.typicalCents !== null ? ` and ${formatCents(at.typicalCents)} in a typical period` : ""
            }.`
          : ""}
      </figcaption>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <svg width="16" height="6">
              <line x1="0" y1="3" x2="16" y2="3" className="stroke-primary" strokeWidth="2" />
            </svg>
            Left
          </span>
          <span className="flex items-center gap-1">
            <svg width="16" height="6">
              <line x1="0" y1="3" x2="16" y2="3" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
            </svg>
            Straight line
          </span>
          {pastPeriods ? (
            <span className="flex items-center gap-1">
              <svg width="16" height="6">
                <line x1="0" y1="3" x2="16" y2="3" className="stroke-foreground/50" strokeWidth="1.5" strokeDasharray="1 3" strokeLinecap="round" />
              </svg>
              Typical ({pastPeriods} past {pastPeriods === 1 ? "period" : "periods"})
            </span>
          ) : null}
        </span>
        {/* The readout: the hovered day, else the latest. */}
        {at ? (
          <span className="tabular-nums text-foreground">
            {dayLabel(at.date, true)}:{" "}
            {at.leftCents !== null ? (
              <span className={at.leftCents < 0 ? "text-negative" : ""}>
                {at.leftCents < 0 ? `${formatCents(-at.leftCents)} over` : `${formatCents(at.leftCents)} left`}
              </span>
            ) : (
              <span className="text-muted-foreground">to come</span>
            )}
            <span className="text-muted-foreground">
              {" "}
              · line {formatCents(at.idealCents)}
              {at.typicalCents !== null ? ` · typical ${formatCents(at.typicalCents)}` : ""}
            </span>
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-hidden
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* Recessive: the zero line, and the full amount. */}
        <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth="1" />
        <line x1={pad.left} x2={W - pad.right} y1={y(availableCents)} y2={y(availableCents)} className="stroke-border" strokeWidth="1" strokeDasharray="2 4" />
        {/* The axis, labelled at the full amount and at zero. */}
        <text x={pad.left + 2} y={y(availableCents) - 3} className="fill-muted-foreground text-[11px]">
          {formatCents(availableCents)}
        </text>
        {bottom < 0 || availableCents > 0 ? (
          <text x={W - pad.right - 2} y={y(0) - 3} textAnchor="end" className="fill-muted-foreground text-[11px]">
            $0
          </text>
        ) : null}
        <path d={ideal} fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
        {pastPeriods ? (
          <path d={path(days.map((d) => d.typicalCents))} fill="none" className="stroke-foreground/50" strokeWidth="1.5" strokeDasharray="1 3" strokeLinecap="round" />
        ) : null}
        <path d={path(days.map((d) => d.leftCents))} fill="none" className="stroke-primary" strokeWidth="2" strokeLinejoin="round" />
        {lastActual >= 0 && days[lastActual].leftCents !== null ? (
          // Where it stands: a marker with a ring of the surface around it.
          <circle cx={x(lastActual)} cy={y(days[lastActual].leftCents!)} r="4" className="fill-primary stroke-background" strokeWidth="2" />
        ) : null}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} className="stroke-foreground/40" strokeWidth="1" /> : null}
        <text x={pad.left} y={height - 4} className="fill-muted-foreground text-[11px]">
          {dayLabel(days[0].date)}
        </text>
        <text x={W - pad.right} y={height - 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
          {dayLabel(days.at(-1)!.date)}
        </text>
      </svg>
    </figure>
  );
}

const TONE: Record<NonNullable<CalendarDay["tone"]>, string> = {
  under: "bg-positive/25",
  near: "bg-positive/50",
  over: "bg-negative/35",
  "far-over": "bg-negative/60",
};

/** Each day against its even share: a month as weeks in rows, a longer period as weeks in columns. */
export function SpendCalendar({ days, share, today }: { days: CalendarDay[]; share: number; today: string | null }) {
  const lead = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  const long = days.length > 31;
  // A longer period's weeks run in columns; each column that holds a 1st is labelled with its month.
  const weeks = Math.ceil(cells.length / 7);
  const monthAt = Array.from({ length: weeks }, (_, w) => {
    const first = cells.slice(w * 7, w * 7 + 7).find((d) => d?.date.endsWith("-01"));
    return first ? new Date(`${first.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) : "";
  });
  const label = (d: CalendarDay) =>
    `${dayLabel(d.date, true)}: ${
      d.spentCents === null ? "still to come" : d.spentCents <= 0 ? (d.spentCents < 0 ? `${formatCents(-d.spentCents)} refunded` : "nothing spent") : `${formatCents(d.spentCents)} spent`
    }, against ${formatCents(share)} a day`;
  return (
    <div className="space-y-1.5">
      <div className={long ? "overflow-x-auto" : ""}>
        {long ? (
          <div className="mb-0.5 grid w-max auto-cols-[0.75rem] grid-flow-col gap-0.5 text-[9px] leading-none text-muted-foreground" aria-hidden>
            {monthAt.map((m, w) => (
              <span key={w} className="overflow-visible whitespace-nowrap">
                {m}
              </span>
            ))}
          </div>
        ) : (
          <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground" aria-hidden>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        )}
        <ol
          className={long ? "grid w-max grid-flow-col grid-rows-7 gap-0.5" : "grid grid-cols-7 gap-1"}
          aria-label={`Spending by day, against an even share of ${formatCents(share)} a day`}
        >
          {cells.map((d, i) =>
            d === null ? (
              <li key={`lead-${i}`} aria-hidden />
            ) : (
              <li
                key={d.date}
                title={label(d)}
                aria-label={label(d)}
                className={`flex items-center justify-center rounded-sm tabular-nums ${long ? "size-3" : "h-9 text-xs"} ${
                  d.tone ? TONE[d.tone] : "border border-border/60"
                } ${d.spentCents === null ? "text-muted-foreground/50" : ""} ${d.date === today ? "outline-1 outline-offset-1 outline-foreground" : ""}`}
              >
                {long ? null : Number(d.date.slice(8, 10))}
              </li>
            ),
          )}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm border border-border/60" aria-hidden /> Nothing spent
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-positive/25" aria-hidden />
          <span className="size-3 rounded-sm bg-positive/50" aria-hidden /> Up to {formatCents(share)} a day
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-negative/35" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/60" aria-hidden /> Over (deeper past double)
        </span>
      </div>
    </div>
  );
}
