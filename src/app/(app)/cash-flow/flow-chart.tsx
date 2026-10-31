"use client";

import { useState } from "react";
import { netBands } from "@/lib/cashflow/chart";
import { formatCents } from "@/lib/money";

// Cash in against cash out over a period (#171, and #172 by day): one axis,
// two lines in the Sankey's own colours for money in and spending, and the
// gap between them shaded by which is ahead, so net reads as an area. Slots
// still to come keep their place on the axis with nothing drawn. Hovering
// or tapping a slot reads out its figures; a table carries the same for
// screen readers and anyone who wants the numbers.

export type FlowSlot = { label: string; title: string; inCents: number; outCents: number } | { label: string; title: string; inCents: null; outCents: null };

const compact = (cents: number) => {
  const d = Math.abs(cents) / 100;
  const s = d >= 1_000 ? `$${(d / 1_000).toFixed(d >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : `$${Math.round(d)}`;
  return cents < 0 ? `−${s}` : s;
};

export function FlowChart({ slots, title, partialIndex = null }: { slots: FlowSlot[]; title: string; partialIndex?: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  // The plot stretches to the width at a fixed height (in % of it), so on
  // a phone it stays tall enough to read; the labels and markers are plain
  // HTML on top, so text keeps its size however wide the chart is.
  const shown = slots.flatMap((s, i) => (s.inCents === null ? [] : [{ i, inCents: s.inCents, outCents: s.outCents }]));
  const top = Math.max(1, ...shown.map((s) => Math.max(s.inCents, s.outCents)));
  const x = (i: number) => (slots.length > 1 ? (i / (slots.length - 1)) * 100 : 50);
  const y = (cents: number) => (1 - Math.max(0, cents) / top) * 100;
  const line = (pick: (s: (typeof shown)[number]) => number) => shown.map((s, k) => `${k ? "L" : "M"}${x(s.i).toFixed(2)},${y(pick(s)).toFixed(2)}`).join("");
  // The bands run over the shown slots, which are contiguous from the start.
  const bands = netBands(shown);
  const ticks = [0, top / 2, top];
  const at = hover ?? shown.at(-1)?.i ?? null;
  const slot = at === null ? null : slots[at];
  // Labels thin out when there are many slots (a month by day).
  const every = slots.length > 16 ? Math.ceil(slots.length / 8) : 1;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (slots.length - 1));
    setHover(Math.max(0, Math.min(slots.length - 1, i)));
  };

  return (
    <figure className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: "var(--flow-income)" }} /> Cash in
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: "var(--flow-spend)" }} /> Cash out
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm" style={{ background: "color-mix(in oklab, var(--flow-income) 20%, transparent)" }} />
            <span className="inline-block size-3 rounded-sm" style={{ background: "color-mix(in oklab, var(--flow-spend) 25%, transparent)" }} /> Net, whichever is ahead
          </span>
        </span>
        {slot && slot.inCents !== null ? (
          <span className="tabular-nums text-foreground">
            {slot.title}
            {at === partialIndex ? " so far" : ""}: in {formatCents(slot.inCents)} · out {formatCents(slot.outCents)} ·{" "}
            <span className={slot.inCents - slot.outCents < 0 ? "text-negative" : slot.inCents - slot.outCents > 0 ? "text-positive" : ""}>
              net {slot.inCents - slot.outCents > 0 ? "+" : slot.inCents - slot.outCents < 0 ? "−" : ""}
              {formatCents(Math.abs(slot.inCents - slot.outCents))}
            </span>
          </span>
        ) : slot ? (
          <span>{slot.title}: still to come</span>
        ) : null}
      </div>
      <div className="flex gap-2">
        {/* The axis: zero, half way and the top. */}
        <div className="relative w-10 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {compact(t)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative h-44 touch-none select-none sm:h-52"
            aria-hidden
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
              {ticks.map((t) => (
                <line key={t} x1="0" x2="100" y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth="1" strokeDasharray={t === 0 ? undefined : "2 4"} vectorEffect="non-scaling-stroke" />
              ))}
              {bands.map((b, k) => (
                <path
                  key={k}
                  d={`${b.points.map((p, j) => `${j ? "L" : "M"}${x(p.x).toFixed(2)},${y(p.inCents).toFixed(2)}`).join("")}${[...b.points]
                    .reverse()
                    .map((p) => `L${x(p.x).toFixed(2)},${y(p.outCents).toFixed(2)}`)
                    .join("")}Z`}
                  style={{ fill: b.ahead === "in" ? "color-mix(in oklab, var(--flow-income) 20%, transparent)" : "color-mix(in oklab, var(--flow-spend) 25%, transparent)" }}
                />
              ))}
              <path d={line((s) => s.outCents)} fill="none" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--flow-spend)" }} />
              <path d={line((s) => s.inCents)} fill="none" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--flow-income)" }} />
              {at !== null ? <line x1={x(at)} x2={x(at)} y1="0" y2="100" className="stroke-foreground/40" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
            </svg>
            {at !== null && slot && slot.inCents !== null ? (
              // Markers with a ring of the surface, so they read on the lines.
              <>
                <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background" style={{ left: `${x(at)}%`, top: `${y(slot.inCents)}%`, background: "var(--flow-income)" }} />
                <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background" style={{ left: `${x(at)}%`, top: `${y(slot.outCents)}%`, background: "var(--flow-spend)" }} />
              </>
            ) : null}
          </div>
          <div className="relative mt-1 h-3 text-[10px] text-muted-foreground" aria-hidden>
            {slots.map((s, i) =>
              i % every === 0 || i === slots.length - 1 ? (
                <span
                  key={i}
                  // On a phone, every other label (from the first), so a year's months don't collide.
                  className={`absolute whitespace-nowrap ${i === 0 ? "" : i === slots.length - 1 ? "-translate-x-full" : "-translate-x-1/2"} ${i === at ? "text-foreground" : ""} ${
                    slots.length > 6 && (i / every) % 2 === 1 ? "max-sm:hidden" : ""
                  }`}
                  style={{ left: `${x(i)}%` }}
                >
                  {s.label}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{title} as a table</summary>
        <table className="mt-2 w-full tabular-nums">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="pb-1 font-normal" />
              <th scope="col" className="pb-1 text-right font-normal">
                In
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                Out
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s, i) =>
              s.inCents === null ? null : (
                <tr key={i} className="border-t">
                  <th scope="row" className="py-1 text-left font-normal">
                    {s.title}
                    {i === partialIndex ? " (so far)" : ""}
                  </th>
                  <td className="py-1 text-right">{formatCents(s.inCents)}</td>
                  <td className="py-1 text-right">{formatCents(s.outCents)}</td>
                  <td className={`py-1 text-right ${s.inCents - s.outCents < 0 ? "text-negative" : ""}`}>{formatCents(s.inCents - s.outCents)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
