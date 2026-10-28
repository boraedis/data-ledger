"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
// A value over time — net worth, an account's balance: one line, drawn in
// SVG at the container's real pixel
// width (measured, not a stretched viewBox) so text and strokes stay crisp
// at any size. No chart library: one series doesn't need one.
//
// Dataviz choices, following Data Diary's guidance:
// - The value axis fits the data rather than starting at zero. These
//   values aren't non-negative measures (net worth can be below zero), and pinning zero
//   would flatten a $250k balance's month-to-month movement into a line.
//   When zero is inside the range it gets its own rule, so crossing it is
//   unmistakable.
// - The readout sits above the plot instead of in a floating tooltip: it
//   works the same under a finger on a phone, and never covers the line.
// - Range buttons only ever narrow what's drawn; the data isn't resampled.

const RANGES = [
  { key: "1m", label: "1M", days: 31 },
  { key: "3m", label: "3M", days: 92 },
  { key: "6m", label: "6M", days: 183 },
  { key: "1y", label: "1Y", days: 366 },
  { key: "all", label: "All", days: Infinity },
] as const;

export type ValuePoint = {
  on: string; // YYYY-MM-DD
  cents: number;
  // A second readout line for this day, formatted by the server
  // ("Assets … · Liabilities …").
  detail?: string;
};
const PAD = { top: 12, right: 8, bottom: 24, left: 8 };

function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** "$1.2M", "$350k", "−$4k" — axis labels only; the readout shows exact cents. */
function compact(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "−" : "";
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatDay(on: string, withYear = true): string {
  return new Date(`${on}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

export function ValueChart({ series, label, height = 220 }: { series: ValuePoint[]; label: string; height?: number }) {
  const HEIGHT = height;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalDays = series.length;
  const visible = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)!.days;
    return Number.isFinite(days) ? series.slice(-days) : series;
  }, [series, range]);

  const geometry = useMemo(() => {
    if (width === 0 || visible.length === 0) return null;
    const values = visible.map((p) => p.cents);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      // A flat line still needs a band to sit in.
      const pad = Math.max(Math.abs(max) * 0.05, 10_000);
      min -= pad;
      max += pad;
    }
    const step = niceStep(max - min, 4);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);

    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (visible.length === 1 ? plotW / 2 : (i / (visible.length - 1)) * plotW);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const path = visible.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join("");
    return { ticks, x, y, path, lo, hi, plotW };
  }, [visible, width, HEIGHT]);

  const shown = visible[hover ?? visible.length - 1];
  const first = visible[0];
  const change = shown && first ? shown.cents - first.cents : 0;

  function pointAt(clientX: number) {
    const el = containerRef.current;
    if (!el || !geometry || visible.length === 0) return;
    const left = el.getBoundingClientRect().left;
    const ratio = (clientX - left - PAD.left) / geometry.plotW;
    setHover(Math.max(0, Math.min(visible.length - 1, Math.round(ratio * (visible.length - 1)))));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        {/* The readout: the hovered day, or the latest one. */}
        <div aria-live="polite" className="min-h-12">
          {shown ? (
            <>
              <div className="text-sm text-muted-foreground">{formatDay(shown.on)}</div>
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="text-lg font-semibold tabular-nums">{formatCents(shown.cents)}</span>
                {visible.length > 1 ? (
                  <span className={`tabular-nums ${change < 0 ? "text-negative" : "text-muted-foreground"}`}>
                    {change >= 0 ? "+" : "−"}
                    {formatCents(Math.abs(change))} since {formatDay(first.on, false)}
                  </span>
                ) : null}
              </div>
              {shown.detail ? <div className="text-xs text-muted-foreground tabular-nums">{shown.detail}</div> : null}
            </>
          ) : null}
        </div>
        <div role="group" aria-label="Time range" className="flex rounded-md border text-xs">
          {RANGES.map((r) => {
            // Ranges longer than the history would all draw the same thing.
            const available = r.key === "all" || r.days < totalDays;
            if (!available) return null;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={range === r.key}
                onClick={() => {
                  setRange(r.key);
                  setHover(null);
                }}
                className={`px-2.5 py-1 first:rounded-l-md last:rounded-r-md ${
                  range === r.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full touch-pan-y select-none"
        style={{ height: HEIGHT }}
        onPointerMove={(e) => pointAt(e.clientX)}
        onPointerDown={(e) => pointAt(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        {geometry ? (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${label} from ${formatDay(first.on)} to ${formatDay(visible.at(-1)!.on)}`}>
            {geometry.ticks.map((t) => (
              <line
                key={t}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geometry.y(t)}
                y2={geometry.y(t)}
                className={t === 0 ? "stroke-foreground/50" : "stroke-border"}
                strokeDasharray={t === 0 ? undefined : "2 3"}
              />
            ))}
            <path d={geometry.path} fill="none" className="stroke-primary" strokeWidth={1.75} strokeLinejoin="round" />
            {/* Labels after the line, with a background-colored halo, so a
                label stays legible where the line runs through it. */}
            {geometry.ticks.map((t) => (
              <text
                key={t}
                x={PAD.left + 2}
                y={geometry.y(t) - 3}
                className="fill-muted-foreground stroke-background text-[10px] tabular-nums"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {compact(t)}
              </text>
            ))}
            {visible.length === 1 ? (
              <circle cx={geometry.x(0)} cy={geometry.y(visible[0].cents)} r={3.5} className="fill-primary" />
            ) : null}
            {hover !== null ? (
              <g>
                <line
                  x1={geometry.x(hover)}
                  x2={geometry.x(hover)}
                  y1={PAD.top}
                  y2={HEIGHT - PAD.bottom}
                  className="stroke-foreground/40"
                />
                <circle cx={geometry.x(hover)} cy={geometry.y(visible[hover].cents)} r={3.5} className="fill-primary" />
              </g>
            ) : null}
            <text x={PAD.left} y={HEIGHT - 6} className="fill-muted-foreground text-[10px]">
              {formatDay(first.on)}
            </text>
            {visible.length > 1 ? (
              <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
                {formatDay(visible.at(-1)!.on)}
              </text>
            ) : null}
          </svg>
        ) : null}
      </div>
    </div>
  );
}
