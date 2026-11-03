"use client";

import { useState } from "react";
import type { PacePoint } from "@/lib/spending/pace";
import { formatCents } from "@/lib/money";

// Spending so far against the typical (#264), above the table. One axis
// (money spent), two lines: the period's running total, solid, and the
// typical, dashed, told apart by style as well as weight, with a legend.
// Hovering (or tapping) a point reads out spent, typical and the
// difference; "As a table" lists every point, and a caption gives the
// latest for screen readers. Styled as the Budgets burndown.

const label = (date: string, unit: "day" | "month", long = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", unit === "month" ? { month: long ? "long" : "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });

function Difference({ spent, typical, short = false }: { spent: number; typical: number; short?: boolean }) {
  const diff = spent - typical;
  if (diff === 0) return <>{short ? "same" : "on typical"}</>;
  // More spending reads as the warning direction, as in the table below, and the sign or words say so too.
  const amount = formatCents(Math.abs(diff));
  return (
    <span className={diff > 0 ? "text-negative" : "text-positive"}>
      {short ? `${diff > 0 ? "+" : "−"}${amount}` : `${amount} ${diff > 0 ? "more" : "less"} than typical`}
    </span>
  );
}

export function PaceChart({ points, unit, typicalLabel, title }: { points: PacePoint[]; unit: "day" | "month"; typicalLabel: string | null; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 120;
  const pad = { top: 18, right: 8, bottom: 18, left: 8 };
  const values = points.flatMap((p) => [p.spentCents ?? 0, p.typicalCents ?? 0]);
  const top = Math.max(1, ...values);
  const x = (i: number) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * (W - pad.left - pad.right) : 0);
  const y = (cents: number) => pad.top + ((top - cents) / top) * (H - pad.top - pad.bottom);
  const path = (vs: (number | null)[]) =>
    vs.reduce<string>((d, v, i) => (v === null ? d : `${d}${d === "" || vs[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  const hasTypical = typicalLabel !== null && points.some((p) => p.typicalCents !== null);
  const last = points.findLastIndex((p) => p.spentCents !== null);
  const shown = hover ?? last;
  const at = shown >= 0 ? points[shown] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    const i = Math.round(((ratio * W - pad.left) / (W - pad.left - pad.right)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <figure className="space-y-1.5">
      <figcaption className="sr-only">
        {title}.{" "}
        {at && at.spentCents !== null
          ? `${label(at.date, unit, true)}: ${formatCents(at.spentCents)} spent${at.typicalCents !== null ? `, against ${formatCents(at.typicalCents)} typical` : ""}.`
          : ""}
      </figcaption>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <svg width="16" height="6">
              <line x1="0" y1="3" x2="16" y2="3" className="stroke-primary" strokeWidth="2" />
            </svg>
            Spent
          </span>
          {hasTypical ? (
            <span className="flex items-center gap-1">
              <svg width="16" height="6">
                <line x1="0" y1="3" x2="16" y2="3" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
              </svg>
              {typicalLabel}
            </span>
          ) : null}
        </span>
        {/* The readout: the hovered point, else the latest. */}
        {at ? (
          <span className="tabular-nums text-foreground">
            {label(at.date, unit, true)}:{" "}
            {at.spentCents !== null ? `${formatCents(at.spentCents)} spent` : <span className="text-muted-foreground">to come</span>}
            {at.typicalCents !== null ? (
              <span className="text-muted-foreground">
                {" "}
                · typical {formatCents(at.typicalCents)}
                {at.spentCents !== null ? (
                  <>
                    {" "}
                    · <Difference spent={at.spentCents} typical={at.typicalCents} />
                  </>
                ) : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-hidden
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth="1" />
        <text x={pad.left + 2} y={pad.top - 5} className="fill-muted-foreground text-[11px]">
          {formatCents(top)}
        </text>
        {hasTypical ? <path d={path(points.map((p) => p.typicalCents))} fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" /> : null}
        <path d={path(points.map((p) => p.spentCents))} fill="none" className="stroke-primary" strokeWidth="2" strokeLinejoin="round" />
        {last >= 0 ? <circle cx={x(last)} cy={y(points[last].spentCents!)} r="4" className="fill-primary stroke-background" strokeWidth="2" /> : null}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={H - pad.bottom} className="stroke-foreground/40" strokeWidth="1" /> : null}
        <text x={pad.left} y={H - 4} className="fill-muted-foreground text-[11px]">
          {label(points[0].date, unit)}
        </text>
        <text x={W - pad.right} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
          {label(points.at(-1)!.date, unit)}
        </text>
      </svg>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">As a table</summary>
        <table className="mt-1 w-full tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-0.5 text-left font-normal">
                {unit === "month" ? "By the end of" : "By"}
              </th>
              <th scope="col" className="py-0.5 text-right font-normal">
                Spent
              </th>
              {hasTypical ? (
                <>
                  <th scope="col" className="py-0.5 text-right font-normal">
                    Typical
                  </th>
                  <th scope="col" className="py-0.5 text-right font-normal">
                    vs typical
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date} className="border-t">
                <th scope="row" className="py-0.5 text-left font-normal">
                  {label(p.date, unit, true)}
                </th>
                <td className="py-0.5 text-right">{p.spentCents === null ? "–" : formatCents(p.spentCents)}</td>
                {hasTypical ? (
                  <>
                    <td className="py-0.5 text-right">{p.typicalCents === null ? "–" : formatCents(p.typicalCents)}</td>
                    <td className="py-0.5 text-right">
                      {p.spentCents !== null && p.typicalCents !== null ? <Difference spent={p.spentCents} typical={p.typicalCents} short /> : "–"}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
