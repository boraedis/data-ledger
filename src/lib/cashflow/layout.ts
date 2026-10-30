import type { FlowGraph, FlowLink, FlowNode, Role } from "@/lib/cashflow/graph";

// Where each node and band of a cash-flow Sankey (#62) sits. Pure geometry,
// no rendering, so it's tested and the chart only draws what it's given.
//
// Columns are the graph's levels: sources, take-home and what came off the
// paycheck, where it went, the breakdown, subcategories. A node is as tall
// as the larger of what flows in and out.

export type PlacedNode = FlowNode & { column: number; x: number; y: number; height: number; inCents: number; outCents: number };
export type PlacedLink = FlowLink & { width: number; sourceY: number; targetY: number; x0: number; x1: number };
export type Layout = { width: number; height: number; nodeWidth: number; columns: number; nodes: PlacedNode[]; links: PlacedLink[] };

// Within a column, top to bottom: income, then what was drawn on; take-home
// above what came off the paycheck; spending, then saved and invested, then
// debt.
const ROLE_ORDER: Role[] = ["income", "draw", "pool", "spend", "saved", "tax", "debt"];

export function layoutFlows(graph: FlowGraph, { width, nodeWidth = 10, gap = 10, minHeight = 320, perNode = 30 }: { width: number; nodeWidth?: number; gap?: number; minHeight?: number; perNode?: number }): Layout {
  const { nodes, links } = graph;
  const incoming = new Map<string, FlowLink[]>();
  const outgoing = new Map<string, FlowLink[]>();
  for (const l of links) {
    incoming.set(l.target, [...(incoming.get(l.target) ?? []), l]);
    outgoing.set(l.source, [...(outgoing.get(l.source) ?? []), l]);
  }

  // Each node's column is its level (graph.ts), with empty levels closed
  // up: a period with no subcategories has four columns, not five.
  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => a - b);
  const column = new Map(nodes.map((n) => [n.id, levels.indexOf(n.level)]));
  const columns = Math.max(1, levels.length);

  const sum = (ls: FlowLink[] | undefined) => (ls ?? []).reduce((s, l) => s + l.valueCents, 0);
  const valueOf = (id: string) => Math.max(sum(incoming.get(id)), sum(outgoing.get(id)));
  const byRole = (a: FlowNode, b: FlowNode) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || valueOf(b.id) - valueOf(a.id) || a.label.localeCompare(b.label);
  const byColumn = Array.from({ length: columns }, (_, c) => nodes.filter((n) => column.get(n.id) === c).sort(byRole));
  const tallest = Math.max(1, ...byColumn.map((c) => c.length));
  const height = Math.max(minHeight, tallest * perNode);
  // One scale for every column: cents per pixel set by the fullest one.
  const scale = Math.min(...byColumn.filter((c) => c.length).map((c) => (height - gap * (c.length - 1)) / Math.max(1, c.reduce((s, n) => s + valueOf(n.id), 0))));

  const step = columns > 1 ? (width - nodeWidth) / (columns - 1) : 0;
  const placed = new Map<string, PlacedNode>();
  // After the first column, each node sits near what feeds it (the
  // value-weighted middle of its sources), so a bucket's breakdown stays
  // beside the bucket instead of crossing its neighbours'.
  const middleOfSources = (id: string) => {
    const ins = incoming.get(id) ?? [];
    const total = sum(ins);
    if (!total) return Infinity;
    const middle = ins.reduce((s, l) => {
      const src = placed.get(l.source);
      return s + (src ? src.y + src.height / 2 : 0) * l.valueCents;
    }, 0) / total;
    // Rounded, so siblings fed by one node tie (and fall back to size order)
    // rather than sorting on floating-point noise.
    return Math.round(middle);
  };
  byColumn.forEach((col, c) => {
    if (c > 0) col.sort((a, b) => middleOfSources(a.id) - middleOfSources(b.id) || byRole(a, b));
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
