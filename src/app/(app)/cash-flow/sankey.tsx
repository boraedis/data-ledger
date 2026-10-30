"use client";

import { useMemo, useRef, useState } from "react";
import type { FlowGraph, Role } from "@/lib/cashflow/graph";
import { bandPath, layoutFlows, type PlacedLink, type PlacedNode } from "@/lib/cashflow/layout";
import { formatCents } from "@/lib/money";

// The cash-flow Sankey (#62), drawn from layoutFlows. Color says what a
// node is: income, saved or invested, spent; taxes, take-home, what was
// drawn on and debt in neutral ink. A band takes the color of where it ends
// up, or of its source when it ends in take-home. Hover, tap or focus a
// band or node for its amount and the transactions behind it; the table
// under the chart lists every flow.

const WIDTH = 960;
const MIN_WIDTH = 720;

const FILL: Record<Role, string> = {
  income: "var(--flow-income)",
  draw: "var(--muted-foreground)",
  pool: "var(--foreground)",
  saved: "var(--flow-saved)",
  spend: "var(--flow-spend)",
  tax: "var(--muted-foreground)",
  debt: "var(--muted-foreground)",
};

type Tip = { x: number; y: number; value: number; title: string; detail: string };

export function Sankey({ graph, label }: { graph: FlowGraph; label: string }) {
  // Full width: the first column's labels sit right of their nodes and the
  // last column's left of theirs, so neither needs a margin.
  const layout = useMemo(() => layoutFlows(graph, { width: WIDTH - 20, gap: 14 }), [graph]);
  const nodes = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const [tip, setTip] = useState<Tip | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const offsetX = 10;
  const height = layout.height + 20;

  const bandColor = (l: PlacedLink) => {
    const target = nodes.get(l.target)!;
    return target.role === "pool" ? FILL[nodes.get(l.source)!.role] : FILL[target.role];
  };
  const linkTip = (l: PlacedLink): Omit<Tip, "x" | "y"> => ({
    value: l.valueCents,
    title: `${nodes.get(l.source)!.label} → ${nodes.get(l.target)!.label}`,
    detail: `${l.count} ${l.count === 1 ? "transaction" : "transactions"}`,
  });
  const nodeTip = (n: PlacedNode): Omit<Tip, "x" | "y"> => ({
    value: Math.max(n.inCents, n.outCents),
    title: n.label,
    detail: [n.inCents ? `in ${formatCents(n.inCents)}` : null, n.outCents ? `out ${formatCents(n.outCents)}` : null].filter(Boolean).join(" · "),
  });

  // Tooltip at the pointer, or for keyboard focus at the mark's middle.
  const show = (id: string, content: Omit<Tip, "x" | "y">, at: { clientX: number; clientY: number } | { svgX: number; svgY: number }) => {
    const rect = box.current?.getBoundingClientRect();
    const svg = box.current?.querySelector("svg")?.getBoundingClientRect();
    if (!rect || !svg) return;
    const k = svg.width / WIDTH;
    const point = "clientX" in at ? { x: at.clientX - rect.left, y: at.clientY - rect.top } : { x: (at.svgX + offsetX) * k + svg.left - rect.left, y: (at.svgY + 10) * k + svg.top - rect.top };
    setActive(id);
    // Kept inside the chart's box, so it never runs off a phone screen.
    setTip({ ...content, x: Math.max(0, Math.min(point.x + 12, rect.width - 220)), y: point.y + 12 });
  };
  const hide = () => {
    setActive(null);
    setTip(null);
  };

  return (
    <div ref={box} className="relative" onPointerLeave={hide}>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          style={{ minWidth: MIN_WIDTH }}
          className="h-auto w-full"
          role="img"
          aria-label={`${label}. The table below lists every flow.`}
        >
          <g transform={`translate(${offsetX}, 10)`}>
            {layout.links.map((l) => {
              const id = `${l.source}→${l.target}`;
              return (
                <path
                  key={id}
                  d={bandPath(l)}
                  fill={bandColor(l)}
                  fillOpacity={active === id ? 0.7 : active ? 0.18 : 0.38}
                  tabIndex={0}
                  aria-label={`${linkTip(l).title}: ${formatCents(l.valueCents)}, ${linkTip(l).detail}`}
                  className="cursor-pointer outline-none transition-[fill-opacity]"
                  onPointerMove={(e) => show(id, linkTip(l), e)}
                  onClick={(e) => (active === id ? hide() : show(id, linkTip(l), e))}
                  onFocus={() => show(id, linkTip(l), { svgX: (l.x0 + l.x1) / 2, svgY: (l.sourceY + l.targetY) / 2 })}
                  onBlur={hide}
                />
              );
            })}
            {layout.nodes.map((n) => {
              // Left half: label to the right of the node; right half: to
              // the left, so neighbouring columns' labels don't collide.
              const right = n.x + layout.nodeWidth / 2 < layout.width / 2;
              return (
                <g key={n.id}>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={layout.nodeWidth}
                    height={n.height}
                    rx={2}
                    fill={FILL[n.role]}
                    tabIndex={0}
                    aria-label={`${n.label}: ${nodeTip(n).detail}`}
                    className="cursor-pointer outline-none"
                    onPointerMove={(e) => show(n.id, nodeTip(n), e)}
                    onClick={(e) => (active === n.id ? hide() : show(n.id, nodeTip(n), e))}
                    onFocus={() => show(n.id, nodeTip(n), { svgX: n.x + layout.nodeWidth, svgY: n.y + n.height / 2 })}
                    onBlur={hide}
                  />
                  {/* Labels sit outside the node, haloed in the surface
                      color so they stay legible over bands. */}
                  <text
                    x={right ? n.x + layout.nodeWidth + 6 : n.x - 6}
                    y={n.y + n.height / 2}
                    dy="0.35em"
                    textAnchor={right ? "start" : "end"}
                    className="pointer-events-none fill-foreground text-[12px]"
                    stroke="var(--background)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {n.label}
                    <tspan className="fill-muted-foreground"> {formatCents(Math.max(n.inCents, n.outCents))}</tspan>
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {tip ? (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: tip.x, top: tip.y }}
          role="status"
        >
          <p className="text-sm font-semibold tabular-nums text-foreground">{formatCents(tip.value)}</p>
          <p className="text-muted-foreground">{tip.title}</p>
          {tip.detail ? <p className="text-muted-foreground">{tip.detail}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
