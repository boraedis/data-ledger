"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import type { HourlyNetWorth } from "@/lib/net-worth-hourly";
import { compact, HEIGHT, niceStep, PAD, signed } from "./chart-scale";

// Net worth by the hour (#338), on the Over time chart's short ranges in the
// line view. Crypto moves by the hour; everything else steps at day
// boundaries, and the note under the chart says so. The newest hour is the
// page's live number. Times are the browser's own.

export const HOURLY_RANGES = ["1d", "1w", "1m", "3m"] as const;
type HourlyRange = (typeof HOURLY_RANGES)[number];
const SPAN_HOURS: Record<HourlyRange, number> = { "1d": 24, "1w": 24 * 7, "1m": 24 * 30, "3m": 24 * 91 };

const formatHour = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" });

export function HourlyChart({ hourly, range }: { hourly: HourlyNetWorth; range: HourlyRange }) {
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const points = useMemo(() => hourly.points.slice(-(SPAN_HOURS[range] + 1)), [hourly, range]);

  const geometry = useMemo(() => {
    if (width === 0 || points.length === 0) return null;
    let lo = Math.min(...points.map((p) => p.cents));
    let hi = Math.max(...points.map((p) => p.cents));
    if (lo === hi) {
      lo -= 5_000;
      hi += 5_000;
    }
    const step = niceStep(hi - lo, 4);
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * plotH;
    const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join("");
    return { ticks, x, y, path, plotW };
  }, [width, points]);

  if (!points.length) return null;
  const at = hover ?? points.length - 1;
  const change = points.at(-1)!.cents - points[0].cents;

  function pointAt(clientX: number) {
    const el = ref.current;
    if (!el || !geometry) return;
    const ratio = (clientX - el.getBoundingClientRect().left - PAD.left) / geometry.plotW;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  }

  return (
    <div className="space-y-2">
      <div aria-live="polite" className="min-h-12">
        <div className="text-sm text-muted-foreground">{hover === null ? "Now" : formatHour(points[at].at)}</div>
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className="text-lg font-semibold tabular-nums">{formatCents(points[at].cents)}</span>
          <span className={`tabular-nums ${change < 0 ? "text-negative" : "text-muted-foreground"}`}>
            {signed(change)} since {formatHour(points[0].at)}
          </span>
        </div>
      </div>
      <div
        ref={ref}
        className="relative w-full touch-pan-y select-none"
        style={{ height: HEIGHT }}
        onPointerMove={(e) => pointAt(e.clientX)}
        onPointerDown={(e) => pointAt(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        {geometry ? (
          <svg width={width} height={HEIGHT} role="img" aria-label={`Net worth by the hour from ${formatHour(points[0].at)} to now.`}>
            {geometry.ticks.map((t) => (
              <line key={t} x1={PAD.left} x2={width - PAD.right} y1={geometry.y(t)} y2={geometry.y(t)} className={t === 0 ? "stroke-foreground/60" : "stroke-border"} strokeDasharray={t === 0 ? undefined : "2 3"} />
            ))}
            <path d={geometry.path} fill="none" className="stroke-foreground" strokeWidth={2} strokeLinejoin="round" />
            {geometry.ticks.map((t) => (
              <text key={t} x={PAD.left + 2} y={geometry.y(t) - 3} className="fill-muted-foreground stroke-background text-[10px] tabular-nums" strokeWidth={3} paintOrder="stroke">
                {compact(t)}
              </text>
            ))}
            {hover !== null ? <line x1={geometry.x(hover)} x2={geometry.x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="stroke-foreground/40" /> : null}
            <text x={PAD.left} y={HEIGHT - 6} className="fill-muted-foreground text-[10px]">
              {formatHour(points[0].at)}
            </text>
            <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
              Now
            </text>
          </svg>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        By the hour. Crypto moves with its hourly price
        {hourly.cryptoFrom ? `, from ${formatHour(hourly.cryptoFrom)}` : " once hourly prices are in"}; cash, loans, stocks and other assets change at the day boundary, since
        banks report no intraday balance and stock prices here are daily. YTD, 1Y and All are by the day.
      </p>
    </div>
  );
}
