"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { PAY_GROUPS, rangeStart, type PayPoint, type PayRange } from "@/lib/pay/chart";
import { GROUP_LABELS, type PayLineGroup } from "@/lib/pay/stubs";

// Paychecks over time (#272), newest at the right. Two views of one chart:
//   - Net: what landed, a line through the regular paychecks, against the
//     typical net (dashed). A bonus is a ring and a net-only stub a square,
//     off the line, so neither reads as a raise or a cut.
//   - Gross: a bar per paycheck, net at the bottom and what came off it
//     stacked on top, so its top is gross.
// The groups are told apart by the readout and the table as well as their
// fill. Hovering (or tapping) a paycheck reads it out; "As a table" lists
// every one. Display only.

// Not --chart-1: that green is too close to net's primary.
const FILL: Record<PayLineGroup, string> = { tax: "var(--chart-3)", insurance: "var(--chart-2)", retirement: "var(--chart-4)", other: "var(--chart-5)" };
const KIND_NOTE = { regular: "", oneTime: "one-time", netOnly: "net only, no gross entered" } as const;
const RANGES: { id: PayRange; label: string }[] = [
  { id: "year", label: "This year" },
  { id: "12", label: "12 months" },
  { id: "all", label: "All" },
];

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={`rounded border px-2 py-0.5 ${o.id === value ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Readout({ p }: { p: PayPoint }) {
  const diff = p.typicalNetCents === null ? null : p.netCents - p.typicalNetCents;
  return (
    <p className="text-xs tabular-nums">
      <span className="font-medium">
        {day(p.payDate)} · {p.employers.join(", ")}
      </span>
      {p.kind !== "regular" ? <span className="ml-1 rounded-sm border px-1 text-[10px] text-muted-foreground">{KIND_NOTE[p.kind]}</span> : null}
      <span className="block text-muted-foreground">
        {p.kind === "netOnly" ? "Gross not entered" : `Gross ${formatCents(p.grossCents)}`}
        {PAY_GROUPS.filter((g) => p.groups[g]).map((g) => ` − ${GROUP_LABELS[g]} ${formatCents(p.groups[g])}`)} ={" "}
        <span className="text-foreground">net {formatCents(p.netCents)}</span>
        {p.typicalNetCents !== null && diff !== null ? (
          <>
            {" "}
            · typical net {formatCents(p.typicalNetCents)}, {diff === 0 ? "the same" : `${formatCents(Math.abs(diff))} ${diff > 0 ? "more" : "less"}`}
            {p.kind === "regular" ? "" : " (not counted in the typical)"}
          </>
        ) : null}
      </span>
    </p>
  );
}

export function PayChart({ points, today }: { points: PayPoint[]; today: string }) {
  // Older stubs than this year make the range worth choosing.
  const spans = points[0].payDate < rangeStart("year", today);
  const [range, setRange] = useState<PayRange>(spans ? "12" : "all");
  const [view, setView] = useState<"net" | "gross">("net");
  const [hover, setHover] = useState<number | null>(null);
  const from = rangeStart(range, today);
  const shown = points.filter((p) => p.payDate >= from);
  const W = 600;
  const H = 170;
  const pad = { top: 18, right: 8, bottom: 18, left: 8 };
  const slot = (W - pad.left - pad.right) / Math.max(1, shown.length);
  const x = (i: number) => pad.left + (i + 0.5) * slot;
  const top = Math.max(1, ...shown.map((p) => (view === "gross" ? p.grossCents : Math.max(p.netCents, p.typicalNetCents ?? 0))));
  const y = (cents: number) => pad.top + ((top - cents) / top) * (H - pad.top - pad.bottom);
  // Lines run through the regular paychecks only; the others are marks.
  const line = (pick: (p: PayPoint) => number | null) =>
    shown.reduce<string>((d, p, i) => {
      const v = p.kind === "regular" ? pick(p) : null;
      return v === null ? d : `${d}${d === "" ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }, "");
  const at = shown[hover ?? shown.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((((e.clientX - box.left) / box.width) * W - pad.left) / slot);
    setHover(Math.max(0, Math.min(shown.length - 1, i)));
  };

  return (
    <section aria-label="Paychecks over time" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Paychecks</h2>
        <div className="flex flex-wrap gap-3">
          <Toggle
            label="Show"
            value={view}
            options={[
              { id: "net", label: "Net" },
              { id: "gross", label: "Gross" },
            ]}
            onChange={setView}
          />
          {spans ? <Toggle label="Range" value={range} options={RANGES} onChange={(r) => (setRange(r), setHover(null))} /> : null}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No paychecks in this range.</p>
      ) : (
        <figure className="space-y-1.5">
          <figcaption className="sr-only">
            {view === "net" ? "Net pay by paycheck, against the typical net of the three regular paychecks before." : "Gross pay by paycheck: net, with what came off it stacked on top."} The
            table below lists every figure.
          </figcaption>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden>
            {view === "net" ? (
              <>
                <span className="flex items-center gap-1">
                  <svg width="16" height="6">
                    <line x1="0" y1="3" x2="16" y2="3" className="stroke-primary" strokeWidth="2" />
                  </svg>
                  Net
                </span>
                <span className="flex items-center gap-1">
                  <svg width="16" height="6">
                    <line x1="0" y1="3" x2="16" y2="3" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
                  </svg>
                  Typical net (3 paychecks before)
                </span>
                <span className="flex items-center gap-1">
                  <svg width="10" height="10">
                    <circle cx="5" cy="5" r="3.5" fill="none" className="stroke-foreground" strokeWidth="1.5" />
                  </svg>
                  One-time
                </span>
                <span className="flex items-center gap-1">
                  <svg width="10" height="10">
                    <rect x="1.5" y="1.5" width="7" height="7" fill="none" className="stroke-foreground" strokeWidth="1.5" />
                  </svg>
                  Net only
                </span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1">
                  <span className="size-2.5 rounded-sm bg-primary" />
                  Net
                </span>
                {PAY_GROUPS.map((g) => (
                  <span key={g} className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm" style={{ background: FILL[g] }} />
                    {GROUP_LABELS[g]}
                  </span>
                ))}
              </>
            )}
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
            {hover !== null ? <rect x={x(hover) - slot / 2} y={pad.top} width={slot} height={H - pad.top - pad.bottom} className="fill-foreground/5" /> : null}
            {view === "gross"
              ? shown.map((p, i) => {
                  const w = Math.max(2, Math.min(24, slot * 0.6));
                  let base = 0;
                  const parts: { key: string; cents: number; fill?: string }[] = [{ key: "net", cents: p.netCents }, ...PAY_GROUPS.map((g) => ({ key: g, cents: p.groups[g], fill: FILL[g] }))];
                  return parts.map((part) => {
                    if (part.cents <= 0) return null;
                    const r = <rect key={`${p.payDate}${i}${part.key}`} x={x(i) - w / 2} y={y(base + part.cents)} width={w} height={y(base) - y(base + part.cents)} className={part.fill ? "" : "fill-primary"} style={part.fill ? { fill: part.fill } : undefined} />;
                    base += part.cents;
                    return r;
                  });
                })
              : (
                  <>
                    <path d={line((p) => p.typicalNetCents)} fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
                    <path d={line((p) => p.netCents)} fill="none" className="stroke-primary" strokeWidth="2" strokeLinejoin="round" />
                    {shown.map((p, i) =>
                      p.kind === "oneTime" ? (
                        <circle key={i} cx={x(i)} cy={y(p.netCents)} r="4" className="fill-background stroke-foreground" strokeWidth="1.5" />
                      ) : p.kind === "netOnly" ? (
                        <rect key={i} x={x(i) - 3.5} y={y(p.netCents) - 3.5} width="7" height="7" className="fill-background stroke-foreground" strokeWidth="1.5" />
                      ) : (
                        <circle key={i} cx={x(i)} cy={y(p.netCents)} r="2" className="fill-primary" />
                      ),
                    )}
                  </>
                )}
            <text x={pad.left} y={H - 4} className="fill-muted-foreground text-[11px]">
              {day(shown[0].payDate)}
            </text>
            <text x={W - pad.right} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {day(shown.at(-1)!.payDate)}
            </text>
          </svg>
          {/* The readout: the hovered paycheck, else the latest. */}
          <div aria-live="polite">{at ? <Readout p={at} /> : null}</div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">As a table</summary>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full min-w-[36rem] tabular-nums">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-0.5 pr-2 text-left font-normal">
                      Paid
                    </th>
                    <th scope="col" className="py-0.5 pr-2 text-right font-normal">
                      Gross
                    </th>
                    {PAY_GROUPS.map((g) => (
                      <th key={g} scope="col" className="py-0.5 pr-2 text-right font-normal">
                        {GROUP_LABELS[g]}
                      </th>
                    ))}
                    <th scope="col" className="py-0.5 pr-2 text-right font-normal">
                      Net
                    </th>
                    <th scope="col" className="py-0.5 text-right font-normal">
                      Typical net
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((p, i) => (
                    <tr key={`${p.payDate}${i}`} className="border-t">
                      <th scope="row" className="py-0.5 pr-2 text-left font-normal">
                        {day(p.payDate)}
                        <span className="block text-muted-foreground">
                          {p.employers.join(", ")}
                          {p.kind !== "regular" ? ` · ${KIND_NOTE[p.kind]}` : ""}
                        </span>
                      </th>
                      <td className="py-0.5 pr-2 text-right">{p.kind === "netOnly" ? "–" : formatCents(p.grossCents)}</td>
                      {PAY_GROUPS.map((g) => (
                        <td key={g} className="py-0.5 pr-2 text-right">
                          {p.groups[g] ? formatCents(p.groups[g]) : "–"}
                        </td>
                      ))}
                      <td className="py-0.5 pr-2 text-right">{formatCents(p.netCents)}</td>
                      <td className="py-0.5 text-right">{p.typicalNetCents === null ? "–" : formatCents(p.typicalNetCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </figure>
      )}
    </section>
  );
}
