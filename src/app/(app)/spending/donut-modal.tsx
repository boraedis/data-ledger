"use client";

import { useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import type { Donut, Slice } from "@/lib/spending/donut";

// The donut (#266), in a modal from a button under the split. A native
// <dialog> opened as modal: it keeps focus inside, closes on Escape, and
// hands focus back to the button. A tooltip on hover, on tap and on
// keyboard focus (each slice is focusable) gives the slice's name, amount,
// share of the whole and, outside, share of its inner slice. The table
// under it lists every row, small ones too, and is the text alternative.
// Colours are the theme's chart colours; an outer slice is a lighter tint
// of its inner one. Never the only cue: the tooltip and the table name
// every slice.

const COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const SIZE = 240;
const C = SIZE / 2;

const pct = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

/** An annular sector from `from` to `to` (shares of the circle), clockwise from the top. */
function arc(from: number, to: number, r0: number, r1: number): string {
  // A whole ring can't be one arc: draw it as two halves.
  if (to - from >= 0.9999) return `${arc(from, from + 0.5, r0, r1)}${arc(from + 0.5, to, r0, r1)}`;
  const point = (share: number, r: number) => {
    const a = share * 2 * Math.PI - Math.PI / 2;
    return `${(C + r * Math.cos(a)).toFixed(2)},${(C + r * Math.sin(a)).toFixed(2)}`;
  };
  const large = to - from > 0.5 ? 1 : 0;
  return `M${point(from, r1)}A${r1},${r1} 0 ${large} 1 ${point(to, r1)}L${point(to, r0)}A${r0},${r0} 0 ${large} 0 ${point(from, r0)}Z`;
}

/** Where a slice's middle is, in the drawing's own units: for a tooltip opened by focus. */
function middle(s: Slice, r: number) {
  const a = ((s.from + s.to) / 2) * 2 * Math.PI - Math.PI / 2;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

export function DonutModal({ donut, title, groupLabel }: { donut: Donut; title: string; groupLabel: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ slice: Slice; x: number; y: number } | null>(null);
  const { inner, outer, totalCents, negative, rows } = donut;
  const rings: [Slice[], number, number, boolean][] = outer
    ? [
        [inner, 52, 82, false],
        [outer, 86, 116, true],
      ]
    : [[inner, 60, 112, false]];

  // In the box's own pixels, kept inside it at its edges (the tooltip is 12rem wide, centred).
  const show = (slice: Slice, x: number, y: number) => {
    const width = box.current!.clientWidth;
    setTip({ slice, x: Math.max(96, Math.min(x, width - 96)), y: Math.max(0, y - 8) });
  };
  const atPointer = (slice: Slice, e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    show(slice, e.clientX - r.left, e.clientY - r.top);
  };
  const atMiddle = (slice: Slice, radius: number) => {
    const r = box.current!.getBoundingClientRect();
    const m = middle(slice, radius);
    show(slice, (m.x / SIZE) * r.width, (m.y / SIZE) * r.height);
  };

  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} className="rounded border px-2 py-1 text-sm hover:bg-muted">
        View as a donut
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="donut-title"
        onClose={() => setTip(null)}
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-lg border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50"
      >
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id="donut-title" className="text-lg font-medium">
              {title}
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} className="rounded border px-2 py-0.5 text-sm hover:bg-muted">
              Close
            </button>
          </div>
          {totalCents <= 0 ? (
            <p className="text-sm text-muted-foreground">Nothing spent to draw.</p>
          ) : (
            <div ref={box} className="relative mx-auto aspect-square w-full max-w-72" onPointerLeave={(e) => e.pointerType !== "touch" && setTip(null)}>
              <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full" role="img" aria-label={`${title}: the table below lists every slice.`}>
                {rings.map(([slices, r0, r1, isOuter]) =>
                  slices.map((s, i) => (
                    <path
                      key={`${isOuter ? "o" : "i"}${s.key}`}
                      d={arc(s.from, s.to, r0, r1)}
                      // Outside, a lighter tint of its slice inside, alternating so neighbours part.
                      style={{ fill: COLOURS[s.index % COLOURS.length], fillOpacity: isOuter ? (i % 2 ? 0.45 : 0.65) : 1 }}
                      className={`stroke-background outline-none focus-visible:stroke-foreground ${tip?.slice === s ? "stroke-foreground" : ""}`}
                      strokeWidth="1.5"
                      tabIndex={0}
                      aria-label={`${s.label}: ${formatCents(s.cents)}, ${pct(s.cents / totalCents)}`}
                      onPointerMove={(e) => atPointer(s, e)}
                      onPointerDown={(e) => atPointer(s, e)}
                      onFocus={() => atMiddle(s, (r0 + r1) / 2)}
                      onBlur={() => setTip(null)}
                    />
                  )),
                )}
                <text x={C} y={C - 4} textAnchor="middle" className="fill-foreground text-[15px] font-semibold tabular-nums">
                  {formatCents(totalCents)}
                </text>
                <text x={C} y={C + 13} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {groupLabel}
                </text>
              </svg>
              {tip ? (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute z-10 w-48 -translate-x-1/2 -translate-y-full rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
                  style={{ left: tip.x, top: tip.y }}
                >
                  <div className="font-medium">{tip.slice.label}</div>
                  <div className="tabular-nums">
                    {formatCents(tip.slice.cents)} · {pct(tip.slice.cents / totalCents)} of all
                  </div>
                  {tip.slice.parent && tip.slice.parent.key !== tip.slice.key ? (
                    <div className="text-muted-foreground tabular-nums">
                      {pct(tip.slice.cents / tip.slice.parent.cents)} of {tip.slice.parent.label}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
          {negative.length ? (
            <p className="text-xs text-muted-foreground">
              Not drawn, as refunds took {negative.length === 1 ? "it" : "them"} below zero:{" "}
              {negative.map((n) => `${n.label} (−${formatCents(-n.cents)})`).join(", ")}.
            </p>
          ) : null}
          <details className="text-xs" open>
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Every {groupLabel.toLowerCase()}, small ones too</summary>
            <table className="mt-1 w-full tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-0.5 text-left font-normal">
                    {groupLabel}
                  </th>
                  <th scope="col" className="py-0.5 text-right font-normal">
                    Spent
                  </th>
                  <th scope="col" className="py-0.5 text-right font-normal">
                    Of all
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((r) => [
                  <tr key={r.key} className="border-t">
                    <th scope="row" className="py-0.5 text-left font-medium">
                      {r.label}
                    </th>
                    <td className="py-0.5 text-right">{formatCents(r.cents)}</td>
                    <td className="py-0.5 text-right">{totalCents > 0 && r.cents > 0 ? pct(r.cents / totalCents) : "–"}</td>
                  </tr>,
                  // A row that is its own only part has nothing more to list.
                  ...(r.children.length === 1 && r.children[0].key === r.key
                    ? []
                    : r.children.map((c) => (
                        <tr key={`${r.key}/${c.key}`}>
                          <th scope="row" className="py-0.5 pl-4 text-left font-normal text-muted-foreground">
                            {c.label}
                          </th>
                          <td className="py-0.5 text-right">{formatCents(c.cents)}</td>
                          <td className="py-0.5 text-right text-muted-foreground">
                            {r.cents > 0 && c.cents > 0 ? `${pct(c.cents / r.cents)} of ${r.label}` : "–"}
                          </td>
                        </tr>
                      ))),
                ])}
              </tbody>
            </table>
          </details>
        </div>
      </dialog>
    </>
  );
}
