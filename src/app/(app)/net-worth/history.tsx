"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountKind } from "@/lib/account-kinds";
import { formatCents } from "@/lib/money";
import {
  RANGES,
  changeOver,
  groupSeries,
  rangeStart,
  stackDay,
  stackSides,
  sumSeries,
  type BreakdownAccount,
  type Daily,
  type GroupBy,
  type RangeKey,
} from "@/lib/net-worth-breakdown";

// Net worth over time, broken down (#134). Opens on the plain line of net
// worth (#195); the stacked view is one toggle away: a stack of each group's
// value per day, assets above zero and what's owed below, with net worth as a
// line on top. Group by kind, account or institution; pick a range; click a
// group to see it alone. SVG at the container's measured width, as ValueChart does.
//
// Dataviz choices:
// - Colour follows the group, never its rank: a kind always has the same
//   hue, so switching range never repaints it. Accounts and institutions take
//   slots in size order, with "Other" in neutral grey.
// - Days before the first balance are blank, not zero: nothing was known.
// - The readout sits above the plot rather than in a floating tooltip, so it
//   works the same under a finger and never covers the stack.
// - The legend carries identity in text (name, value, change), so colour is
//   never the only cue.

const KIND_SLOT: Record<AccountKind, number> = {
  checking: 1,
  savings: 3,
  payment_app: 4,
  brokerage: 7,
  retirement: 6,
  other_asset: 5,
  loan: 2,
  credit: 8,
};
const colorOf = (g: { key: string; kind?: AccountKind }, i: number) =>
  g.key === "other" ? "var(--chart-5)" : `var(--series-${g.kind ? KIND_SLOT[g.kind] : (i % 8) + 1})`;

const HEIGHT = 240;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

function niceStep(span: number, ticks: number) {
  const raw = span / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
}

function compact(cents: number) {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "−" : "";
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

const formatDay = (on: string) => new Date(`${on}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatCents(Math.abs(cents))}`;

type View = "line" | "stacked";

export function NetWorthHistory({ accounts, daily }: { accounts: BreakdownAccount[]; daily: Daily }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [view, setView] = useState<View>("line");
  const [range, setRange] = useState<RangeKey>("all");
  const [selected, setSelected] = useState<string | null>(null);
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

  const groups = useMemo(() => groupSeries(accounts, daily, groupBy).map((g, i) => ({ ...g, color: colorOf(g, i) })), [accounts, daily, groupBy]);
  const total = useMemo(() => sumSeries(Object.values(daily.byAccount), daily.days.length), [daily]);
  const firstDay = daily.days[0];
  const lastDay = daily.days.at(-1)!;
  const from = rangeStart(range, lastDay, firstDay);
  // The domain is the whole range; days before history are blank.
  const lead = Math.max(0, daysBetween(from, firstDay));
  const startIdx = Math.max(0, daysBetween(firstDay, from));
  const visibleDays = daily.days.slice(startIdx);
  const domain = lead + visibleDays.length;
  const shown = useMemo(() => (selected ? groups.filter((g) => g.key === selected) : groups), [groups, selected]);
  const line = useMemo(() => (selected ? (shown[0]?.values ?? []) : total), [selected, shown, total]);

  const geometry = useMemo(() => {
    if (width === 0 || visibleDays.length === 0) return null;
    // Each day's stack: positives up from zero, negatives down, in group
    // order. A zero balance keeps its group's side (#195). The line view has
    // no stack, only the line's own values.
    const stacked = view === "stacked";
    const sides = shown.map((g) => stackSides(g.values));
    const stacks = stacked ? visibleDays.map((_, j) => stackDay(shown.map((g) => g.values[startIdx + j]), sides.map((sd) => sd[startIdx + j]))) : [];
    let lo = 0;
    let hi = 0;
    for (const s of stacks) {
      for (const b of s) {
        lo = Math.min(lo, b.y1);
        hi = Math.max(hi, b.y1);
      }
    }
    // The line sets the scale on its own in the line view, and can reach past the stack's edge in the other.
    for (let j = 0; j < visibleDays.length; j++) {
      const v = line[startIdx + j];
      if (v === null || v === undefined) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (lo === hi) hi = lo + 10_000;
    const step = niceStep(hi - lo, 4);
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (domain <= 1 ? plotW / 2 : (i / (domain - 1)) * plotW);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * plotH;
    const areas = (stacked ? shown : []).map((_, gi) => {
      const top = stacks.map((s, j) => `${x(lead + j).toFixed(1)},${y(s[gi].y1).toFixed(1)}`);
      const bottom = stacks.map((s, j) => `${x(lead + j).toFixed(1)},${y(s[gi].y0).toFixed(1)}`).reverse();
      return `M${top.join("L")}L${bottom.join("L")}Z`;
    });
    const netPath = visibleDays
      .map((_, j) => ({ j, v: line[startIdx + j] }))
      .filter((p) => p.v !== null)
      .map((p, k) => `${k ? "L" : "M"}${x(lead + p.j).toFixed(1)},${y(p.v!).toFixed(1)}`)
      .join("");
    return { ticks, x, y, areas, netPath, plotW };
  }, [width, visibleDays, shown, startIdx, lead, domain, line, view]);

  // The readout and legend show the hovered day, else the latest.
  const beforeHistory = hover !== null && hover < lead;
  const at = hover !== null && !beforeHistory ? startIdx + hover - lead : daily.days.length - 1;
  const lineChange = changeOver(daily.days, line, from);

  function pointAt(clientX: number) {
    const el = ref.current;
    if (!el || !geometry) return;
    const ratio = (clientX - el.getBoundingClientRect().left - PAD.left) / geometry.plotW;
    setHover(Math.max(0, Math.min(domain - 1, Math.round(ratio * (domain - 1)))));
  }

  const button = (active: boolean) =>
    `px-2.5 py-1 first:rounded-l-md last:rounded-r-md ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Chart type" className="flex rounded-md border text-xs">
          {(["line", "stacked"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={button(view === v)} onClick={() => setView(v)}>
              {v === "line" ? "Line" : "Stacked"}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Group by" className="flex rounded-md border text-xs">
          {(["kind", "account", "institution"] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={groupBy === g}
              className={button(groupBy === g)}
              onClick={() => {
                setGroupBy(g);
                setSelected(null);
              }}
            >
              {g === "kind" ? "Kind" : g === "account" ? "Account" : "Institution"}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Time range" className="flex rounded-md border text-xs">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} className={button(range === r.key)} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite" className="min-h-12">
        <div className="text-sm text-muted-foreground">
          {beforeHistory ? "Before your first balance" : formatDay(daily.days[at])}
          {selected ? ` · ${shown[0]?.label}` : ""}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className="text-lg font-semibold tabular-nums">{beforeHistory || line[at] === null ? "—" : formatCents(line[at] ?? 0)}</span>
          {lineChange ? (
            <span className={`tabular-nums ${lineChange.changeCents < 0 ? "text-negative" : "text-muted-foreground"}`}>
              {signed(lineChange.changeCents)} since {formatDay(lineChange.since)}
            </span>
          ) : null}
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
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${selected ? shown[0]?.label : "Net worth"} from ${formatDay(from)} to ${formatDay(lastDay)}${view === "stacked" ? `, stacked by ${groupBy}` : ""}. The legend below lists each group's value and change.`}
          >
            {geometry.ticks.map((t) => (
              <line
                key={t}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geometry.y(t)}
                y2={geometry.y(t)}
                className={t === 0 ? "stroke-foreground/60" : "stroke-border"}
                strokeDasharray={t === 0 ? undefined : "2 3"}
              />
            ))}
            {geometry.areas.map((d, i) => (
              // A thin surface-coloured edge keeps neighbouring bands apart.
              <path key={shown[i].key} d={d} style={{ fill: shown[i].color }} className="stroke-background" strokeWidth={1} fillOpacity={0.85} />
            ))}
            <path d={geometry.netPath} fill="none" className="stroke-foreground" strokeWidth={2} strokeLinejoin="round" />
            {geometry.ticks.map((t) => (
              <text key={t} x={PAD.left + 2} y={geometry.y(t) - 3} className="fill-muted-foreground stroke-background text-[10px] tabular-nums" strokeWidth={3} paintOrder="stroke">
                {compact(t)}
              </text>
            ))}
            {hover !== null ? <line x1={geometry.x(hover)} x2={geometry.x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="stroke-foreground/40" /> : null}
            <text x={PAD.left} y={HEIGHT - 6} className="fill-muted-foreground text-[10px]">
              {formatDay(from)}
            </text>
            <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {formatDay(lastDay)}
            </text>
          </svg>
        ) : null}
      </div>

      {/* The legend is also the filter: click a group to see it alone. */}
      <ul className="divide-y rounded-lg border text-sm">
        {groups.map((g) => {
          const change = changeOver(daily.days, g.values, from);
          const active = selected === g.key;
          return (
            <li key={g.key}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(active ? null : g.key)}
                className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1.5 text-left hover:bg-muted/50 ${
                  selected && !active ? "opacity-50" : ""
                } ${active ? "bg-muted/60" : ""}`}
              >
                <span className="size-3 rounded-sm" style={{ background: g.color }} aria-hidden />
                <span className="truncate">{g.label}</span>
                <span className="text-right tabular-nums">
                  {beforeHistory || g.values[at] === null ? "—" : formatCents(g.values[at] ?? 0)}
                  {change ? (
                    <span className={`ml-2 text-xs ${change.changeCents < 0 ? "text-negative" : "text-muted-foreground"}`}>{signed(change.changeCents)}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {view === "stacked" ? "Assets stack above zero and what's owed below; the line" : "The line"} is {selected ? "the selected group" : "net worth"}. Changes are over the range, from
        its first day or the first day there&apos;s a balance after it.{selected ? " Click it again to see every group." : " Click a group to see it alone."}
      </p>
    </div>
  );
}
