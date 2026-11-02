"use client";

import { useState } from "react";
import type { BurndownDay } from "@/lib/budgets/burndown";
import { formatCents } from "@/lib/money";

// A budget period day by day (#149): the burndown, on the Month view.
//
// The burndown is one axis (money left) with three lines: this period's
// actual, the straight line from the full amount to zero, and what a typical
// past period had left by the same day. Series are told apart by line style
// as well as weight, with a legend.
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
