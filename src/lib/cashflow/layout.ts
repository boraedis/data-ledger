import type { FlowGraph, FlowLink, FlowNode, Role } from "@/lib/cashflow/graph";

// Where each node and band of a cash-flow Sankey (#62) sits. Pure geometry,
// no rendering, so it's tested and the chart only draws what it's given.
//
// Columns are the longest path from a source: pay sits left, its taxes and
// elections one step right, beside the accounts the take-home lands in;
// spending follows the account it left, and a subcategory follows its
// parent. A node is as tall as the larger of what flows in and out.

export type PlacedNode = FlowNode & { column: number; x: number; y: number; height: number; inCents: number; outCents: number };
export type PlacedLink = FlowLink & { width: number; sourceY: number; targetY: number; x0: number; x1: number };
export type Layout = { width: number; height: number; nodeWidth: number; columns: number; nodes: PlacedNode[]; links: PlacedLink[] };

// Within a column, top to bottom: money in, then where it's kept, then
// where it went.
const ROLE_ORDER: Role[] = ["income", "account", "saved", "tax", "transfer", "spend"];

export function layoutFlows(graph: FlowGraph, { width, nodeWidth = 10, gap = 10, minHeight = 320, perNode = 30 }: { width: number; nodeWidth?: number; gap?: number; minHeight?: number; perNode?: number }): Layout {
  const { nodes, links } = graph;
  const incoming = new Map<string, FlowLink[]>();
  const outgoing = new Map<string, FlowLink[]>();
  for (const l of links) {
    incoming.set(l.target, [...(incoming.get(l.target) ?? []), l]);
    outgoing.set(l.source, [...(outgoing.get(l.source) ?? []), l]);
  }

  // Longest path from a source. A cycle (rare: transfers are netted per
  // pair) stops at the node count rather than looping. An account never
  // sits in the income column, even in a month nothing flowed into it (a
  // card only spent from), or its spending would cut across the pay.
  const hasIncome = nodes.some((n) => n.role === "income");
  const column = new Map(nodes.map((n) => [n.id, n.role === "account" && hasIncome ? 1 : 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const l of links) {
      const next = column.get(l.source)! + 1;
      if (next > column.get(l.target)! && next < nodes.length) {
        column.set(l.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = Math.max(1, ...[...column.values()].map((c) => c + 1));

  const sum = (ls: FlowLink[] | undefined) => (ls ?? []).reduce((s, l) => s + l.valueCents, 0);
  const valueOf = (id: string) => Math.max(sum(incoming.get(id)), sum(outgoing.get(id)));
  const byColumn = Array.from({ length: columns }, (_, c) =>
    nodes
      .filter((n) => column.get(n.id) === c)
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || valueOf(b.id) - valueOf(a.id) || a.label.localeCompare(b.label)),
  );
  const tallest = Math.max(1, ...byColumn.map((c) => c.length));
  const height = Math.max(minHeight, tallest * perNode);
  // One scale for every column: cents per pixel set by the fullest one.
  const scale = Math.min(...byColumn.filter((c) => c.length).map((c) => (height - gap * (c.length - 1)) / Math.max(1, c.reduce((s, n) => s + valueOf(n.id), 0))));

  const step = columns > 1 ? (width - nodeWidth) / (columns - 1) : 0;
  const placed = new Map<string, PlacedNode>();
  byColumn.forEach((col, c) => {
    let y = 0;
    for (const n of col) {
      const h = Math.max(1, valueOf(n.id) * scale);
      placed.set(n.id, { ...n, column: c, x: c * step, y, height: h, inCents: sum(incoming.get(n.id)), outCents: sum(outgoing.get(n.id)) });
      y += h + gap;
    }
  });

  // Bands leave each node in the order of their targets, and arrive in the
  // order of their sources, so they don't cross at the ends.
  const outY = new Map<string, number>();
  const inY = new Map<string, number>();
  const placedLinks: PlacedLink[] = [];
  const order = [...links].sort((a, b) => placed.get(a.target)!.y - placed.get(b.target)!.y || placed.get(a.source)!.y - placed.get(b.source)!.y);
  for (const l of order) {
    const s = placed.get(l.source)!;
    const w = Math.max(1, l.valueCents * scale);
    const sy = outY.get(s.id) ?? s.y;
    outY.set(s.id, sy + w);
    placedLinks.push({ ...l, width: w, sourceY: sy + w / 2, targetY: 0, x0: s.x + nodeWidth, x1: placed.get(l.target)!.x });
  }
  for (const pl of [...placedLinks].sort((a, b) => placed.get(a.source)!.y - placed.get(b.source)!.y || a.sourceY - b.sourceY)) {
    const t = placed.get(pl.target)!;
    const ty = inY.get(t.id) ?? t.y;
    inY.set(t.id, ty + pl.width);
    pl.targetY = ty + pl.width / 2;
  }

  return { width, height, nodeWidth, columns, nodes: [...placed.values()], links: placedLinks };
}

/** The band's outline: a ribbon from source to target, as wide as its value. */
export function bandPath(l: PlacedLink): string {
  const mid = (l.x0 + l.x1) / 2;
  const h = l.width / 2;
  return [
    `M${l.x0},${l.sourceY - h}`,
    `C${mid},${l.sourceY - h} ${mid},${l.targetY - h} ${l.x1},${l.targetY - h}`,
    `L${l.x1},${l.targetY + h}`,
    `C${mid},${l.targetY + h} ${mid},${l.sourceY + h} ${l.x0},${l.sourceY + h}`,
    "Z",
  ].join(" ");
}
