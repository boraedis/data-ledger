"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { scheduleLabel, periodLabel } from "@/lib/budgets/format";
import { gridSegments, type Segment, type YearTotal } from "@/lib/budgets/year";
import { formatCents } from "@/lib/money";

// The Year view's grid (#108, #124) with a tooltip on every square (#139):
// what the square is made of, styled, on hover, on keyboard focus and on a
// tap. One tooltip at a time; Escape or a tap elsewhere closes it. No native
// title tooltips, so the two never show together; each square still has an
// aria-label for screen readers.
//
// On a phone a tap opens the tooltip rather than following the link (there's
// no hover to preview with), and the tooltip carries the links instead.
//
// A quarterly or annual target's period is one box spanning its months
// (#157), with the period's own target and spend; a period running past
// either edge is clipped there, marked with ‹ or ›, and its tooltip gives
// the whole period.

export type Period = {
  start: string;
  end: string;
  periodMonths: number;
  targetCents: number;
  carryInCents: number;
  adjustmentsCents: number;
  availableCents: number;
  spentCents: number;
  rollover: boolean;
};
export type GridCell = {
  month: string;
  spentCents: number;
  targetCents: number | null;
  transactions: number;
  period?: Period | null;
  href: string;
  transactionsHref: string | null;
};
export type GridRow = { key: string; name: string; isBuffer: boolean; months: GridCell[]; total: YearTotal | null; over: number; targeted: number };
// Pay and saving for each month (#138), under the grid.
export type PayMonth = { month: string; payCents: number | null; savedCents: number | null };
export type GridColumn = { month: string; href: string; total: YearTotal | null; over: number; targets: number };

const monthName = (month: string, style: "narrow" | "short" | "long") =>
  new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: style,
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

/** "$42", "$1.2k": short enough for a column. */
function compact(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(dollars >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `$${Math.round(dollars)}`;
}

/** "+$42", "−$1.2k": the cell's over (+) or under (−). */
const compactDiff = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${compact(cents)}`;

// Diverging around the target: under in the on-track color, over in the
// over-budget color, three steps each by how far off. Capped well short of
// solid so the amount on top stays legible in both themes.
function shade(spent: number, target: number): string {
  const ratio = target > 0 ? spent / target : spent > 0 ? Infinity : 0;
  if (ratio > 1) return ratio > 1.25 ? "bg-negative/60" : ratio > 1.1 ? "bg-negative/40" : "bg-negative/20";
  return ratio < 0.5 ? "bg-positive/45" : ratio < 0.9 ? "bg-positive/30" : "bg-positive/15";
}

const underOver = (spent: number, target: number) =>
  spent > target ? `${formatCents(spent - target)} over` : `${formatCents(target - spent)} under`;

type Tip = { id: string; body: React.ReactNode; align: "left" | "center" | "right" };

export function YearGrid({
  rows,
  columns,
  grand,
  viewedMonth,
  partial,
  pay,
  payTotals,
}: {
  rows: GridRow[];
  columns: GridColumn[];
  grand: YearTotal | null;
  viewedMonth: string;
  partial: string | null;
  pay?: PayMonth[];
  payTotals?: { netPayCents: number; savedCents: number } | null;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const touch = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTip(null);
    const onDown = (e: PointerEvent) => {
      if (!tableRef.current?.contains(e.target as Node)) setTip(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  // Near the right edge the tooltip opens leftwards, so it stays on screen.
  const alignFor = (col: number) => (col < 3 ? "left" : col > columns.length - 4 ? "right" : "center");

  // Hover (on the whole cell, so moving into the tooltip keeps it open) and
  // focus show it; a tap toggles it instead of navigating.
  const show = (id: string, col: number, body: React.ReactNode) => setTip({ id, body, align: alignFor(col) });
  const hide = (id: string) => setTip((t) => (t?.id === id ? null : t));
  const cellProps = (id: string, col: number, body: React.ReactNode) => ({
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") show(id, col, body);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") hide(id);
    },
  });
  const triggerProps = (id: string, col: number, body: React.ReactNode) => ({
    onPointerDown: (e: React.PointerEvent) => {
      touch.current = e.pointerType === "touch";
    },
    onFocus: () => show(id, col, body),
    // Focus moving into the tooltip's own links keeps it open.
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) hide(id);
    },
    onClick: (e: React.MouseEvent) => {
      if (!touch.current) return;
      e.preventDefault();
      setTip((t) => (t?.id === id ? null : { id, body, align: alignFor(col) }));
    },
  });

  const bubble = (id: string) =>
    tip?.id === id ? (
      // Padding, not margin, between square and tooltip: no gap to fall through.
      <div
        className={`absolute bottom-full z-20 pb-1 ${tip.align === "left" ? "left-0" : tip.align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"}`}
      >
        <div role="tooltip" className="w-56 rounded-md border bg-popover p-2 text-left text-xs text-popover-foreground shadow-md">
          {tip.body}
        </div>
      </div>
    ) : null;

  const cellBody = (r: GridRow, c: GridCell) => (
    <div className="space-y-1">
      <div className="font-medium">
        {r.name} · {monthName(c.month, "long")}
        {c.month === partial ? " so far" : ""}
      </div>
      {c.targetCents === null ? (
        <div>{c.spentCents ? `${formatCents(c.spentCents)} spent, ` : ""}no target that month</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="text-right">
            {formatCents(c.targetCents)}
            {c.period && c.period.periodMonths > 1 ? ` (${scheduleLabel(c.period.periodMonths)} share)` : ""}
          </dd>
          <dt className="text-muted-foreground">Spent</dt>
          <dd className="text-right">{formatCents(c.spentCents)}</dd>
          <dt className="text-muted-foreground">{c.spentCents > c.targetCents ? "Over" : "Under"}</dt>
          <dd className={`text-right ${c.spentCents > c.targetCents ? "text-negative" : ""}`}>{formatCents(Math.abs(c.spentCents - c.targetCents))}</dd>
          <dt className="text-muted-foreground">Transactions</dt>
          <dd className="text-right">{c.transactions}</dd>
          {c.period?.rollover ? (
            <>
              <dt className="text-muted-foreground">Rolled in</dt>
              <dd className="text-right">{formatCents(c.period.carryInCents)}</dd>
              <dt className="text-muted-foreground">Available</dt>
              <dd className="text-right">
                {formatCents(c.period.availableCents)}
                {c.period.periodMonths > 1 ? ` for ${periodLabel(c.period.start, c.period.end)}` : ""}
              </dd>
            </>
          ) : null}
        </dl>
      )}
      <div className="flex gap-3 pt-0.5">
        <Link href={c.href} className="underline">
          Open {monthName(c.month, "short")}
        </Link>
        {c.transactionsHref ? (
          <Link href={c.transactionsHref} className="underline">
            Transactions
          </Link>
        ) : null}
      </div>
    </div>
  );

  const periodBody = (r: GridRow, seg: Segment<GridCell>) => {
    const p = seg.cells[0].period!;
    const last = seg.cells.at(-1)!;
    const soFar = seg.cells.some((c) => c.month === partial) || seg.clippedAfter;
    return (
      <div className="space-y-1">
        <div className="font-medium">
          {r.name} · {periodLabel(p.start, p.end)}
          {soFar ? " so far" : ""}
        </div>
        {seg.clippedBefore || seg.clippedAfter ? (
          <div className="text-muted-foreground">Runs {periodLabel(p.start, p.end)}; only part of it is in these 12 months.</div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="text-right">
            {formatCents(p.targetCents)} ({scheduleLabel(p.periodMonths)})
          </dd>
          <dt className="text-muted-foreground">Spent</dt>
          <dd className="text-right">{formatCents(p.spentCents)}</dd>
          <dt className="text-muted-foreground">{p.spentCents > p.targetCents ? "Over" : "Under"}</dt>
          <dd className={`text-right ${p.spentCents > p.targetCents ? "text-negative" : ""}`}>{formatCents(Math.abs(p.spentCents - p.targetCents))}</dd>
          {/* Counted per month, so only for the months shown. */}
          <dt className="text-muted-foreground">Transactions{seg.clippedBefore || seg.clippedAfter ? " shown" : ""}</dt>
          <dd className="text-right">{seg.cells.reduce((n, c) => n + c.transactions, 0)}</dd>
          {p.rollover ? (
            <>
              <dt className="text-muted-foreground">Rolled in</dt>
              <dd className="text-right">{formatCents(p.carryInCents)}</dd>
              <dt className="text-muted-foreground">Available</dt>
              <dd className="text-right">{formatCents(p.availableCents)}</dd>
            </>
          ) : null}
        </dl>
        <div className="flex gap-3 pt-0.5">
          <Link href={last.href} className="underline">
            Open {monthName(last.month, "short")}
          </Link>
          {last.transactionsHref ? (
            <Link href={last.transactionsHref} className="underline">
              Transactions
            </Link>
          ) : null}
        </div>
      </div>
    );
  };

  const totalBody = (label: string, t: YearTotal, overLine: string) => (
    <div className="space-y-1">
      <div className="font-medium">{label}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
        <dt className="text-muted-foreground">Target</dt>
        <dd className="text-right">{formatCents(t.targetCents)}</dd>
        <dt className="text-muted-foreground">Spent</dt>
        <dd className="text-right">{formatCents(t.spentCents)}</dd>
        <dt className="text-muted-foreground">{t.spentCents > t.targetCents ? "Over" : "Under"}</dt>
        <dd className={`text-right ${t.spentCents > t.targetCents ? "text-negative" : ""}`}>{formatCents(Math.abs(t.spentCents - t.targetCents))}</dd>
      </dl>
      <div className="text-muted-foreground">{overLine}</div>
    </div>
  );

  const totalCell = (id: string, label: string, t: YearTotal | null, overLine: string, strong = false) => {
    if (!t) return <td className="h-9 p-0 pl-1" />;
    const diff = t.spentCents - t.targetCents;
    return (
      <td className={`relative h-9 p-0 pl-1 ${strong ? "pt-1" : ""}`} {...cellProps(id, columns.length, totalBody(label, t, overLine))}>
        <button
          type="button"
          aria-label={`${label}: ${formatCents(t.spentCents)} of ${formatCents(t.targetCents)}, ${underOver(t.spentCents, t.targetCents)}. ${overLine}`}
          {...triggerProps(id, columns.length, totalBody(label, t, overLine))}
          className={`flex h-full w-full flex-col items-center justify-center rounded-sm leading-tight tabular-nums focus-visible:outline-2 focus-visible:outline-ring ${shade(t.spentCents, t.targetCents)} ${strong ? "font-medium" : ""}`}
        >
          <span className="text-[10px]">{compactDiff(diff)}</span>
          <span className="hidden text-[9px] text-muted-foreground sm:block">
            {compact(t.spentCents)} of {compact(t.targetCents)}
          </span>
        </button>
        {bubble(id)}
      </td>
    );
  };

  return (
    <table ref={tableRef} className="w-full table-fixed border-separate border-spacing-0.5 text-xs">
      <caption className="sr-only">
        Spending against target by month, {monthName(columns[0].month, "long")} to {monthName(columns.at(-1)!.month, "long")}
        {partial ? " (the last month so far)" : ""}
      </caption>
      <colgroup>
        <col className="w-24 sm:w-40" />
        {columns.map((c) => (
          <col key={c.month} />
        ))}
        <col className="w-14 sm:w-24" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="sr-only">
            Target
          </th>
          {columns.map((c) => (
            <th
              key={c.month}
              scope="col"
              abbr={monthName(c.month, "long")}
              className={`pb-1 text-center font-normal text-muted-foreground ${c.month.slice(0, 7) === viewedMonth ? "font-medium text-foreground" : ""}`}
            >
              <span className="md:hidden">{monthName(c.month, "narrow")}</span>
              <span className="hidden md:inline">{monthName(c.month, "short")}</span>
              {/* Where the year turns, so twelve months never read as one calendar year. */}
              {c.month.slice(5, 7) === "01" ? <span className="block text-[9px] leading-none">{c.month.slice(2, 4)}</span> : null}
            </th>
          ))}
          <th scope="col" abbr="Total of the months with a target" className="pb-1 pl-1 text-center font-medium">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} id={`year-${r.key}`} className="scroll-mt-4 target:[&>th]:underline">
            <th scope="row" className="pr-1 text-left align-middle font-normal">
              <span className="block truncate text-sm">{r.isBuffer ? "Buffer" : r.name}</span>
              <span className="block text-[10px] text-muted-foreground tabular-nums">
                over {r.over} of {r.targeted}
              </span>
            </th>
            {gridSegments(r.months).map((seg) => {
              const ci = seg.first;
              if (seg.period) {
                const p = seg.period;
                const id = `${r.key}:${p.start}`;
                const body = periodBody(r, seg);
                const soFar = seg.cells.some((c) => c.month === partial) || seg.clippedAfter;
                const last = seg.cells.at(-1)!;
                return (
                  <td key={p.start} colSpan={seg.cells.length} className="relative h-9 p-0" {...cellProps(id, ci, body)}>
                    <Link
                      href={last.href}
                      aria-label={`${r.name}, ${periodLabel(p.start, p.end)}${soFar ? " so far" : ""}: ${formatCents(p.spentCents)} of ${formatCents(p.targetCents)}, ${underOver(p.spentCents, p.targetCents)}`}
                      {...triggerProps(id, ci, body)}
                      className={`flex h-full items-center justify-center gap-1 rounded-sm tabular-nums hover:ring-1 hover:ring-foreground/50 focus-visible:outline-2 focus-visible:outline-ring ${shade(p.spentCents, p.targetCents)} ${
                        seg.clippedBefore ? "rounded-l-none" : ""
                      } ${seg.clippedAfter ? "rounded-r-none" : ""} ${soFar ? "outline-1 -outline-offset-2 outline-dashed outline-foreground/40" : ""}`}
                    >
                      {seg.clippedBefore ? <span aria-hidden className="absolute left-0.5 text-[10px] text-muted-foreground">‹</span> : null}
                      <span aria-hidden className="hidden text-[10px] md:inline">
                        {compactDiff(p.spentCents - p.targetCents)}
                      </span>
                      {/* Where there's room, the period's figures. */}
                      {seg.cells.length >= 3 ? (
                        <span aria-hidden className="hidden text-[9px] text-muted-foreground md:inline">
                          {compact(p.spentCents)} of {compact(p.targetCents)}
                        </span>
                      ) : null}
                      {seg.clippedAfter ? <span aria-hidden className="absolute right-0.5 text-[10px] text-muted-foreground">›</span> : null}
                    </Link>
                    {bubble(id)}
                  </td>
                );
              }
              const c = seg.cells[0];
              const id = `${r.key}:${c.month}`;
              const label =
                c.targetCents === null
                  ? `${r.name}, ${monthName(c.month, "long")}: no target`
                  : `${r.name}, ${monthName(c.month, "long")}${c.month === partial ? " so far" : ""}: ${formatCents(c.spentCents)} of ${formatCents(c.targetCents)}, ${underOver(c.spentCents, c.targetCents)}, ${c.transactions} transaction${c.transactions === 1 ? "" : "s"}`;
              return (
                <td key={c.month} className="relative h-9 p-0" {...cellProps(id, ci, cellBody(r, c))}>
                  <Link
                    href={c.href}
                    aria-label={label}
                    {...triggerProps(id, ci, cellBody(r, c))}
                    className={`flex h-full items-center justify-center rounded-sm tabular-nums hover:ring-1 hover:ring-foreground/50 focus-visible:outline-2 focus-visible:outline-ring ${
                      c.targetCents === null ? "bg-muted/50 text-muted-foreground" : shade(c.spentCents, c.targetCents)
                    } ${c.month === partial ? "outline-1 -outline-offset-2 outline-dashed outline-foreground/40" : ""}`}
                  >
                    <span aria-hidden className="hidden text-[10px] md:inline">
                      {c.targetCents === null ? "–" : compactDiff(c.spentCents - c.targetCents)}
                    </span>
                  </Link>
                  {bubble(id)}
                </td>
              );
            })}
            {totalCell(
              `${r.key}:total`,
              `${r.name}, ${r.total?.months ?? 0} months with a target`,
              r.total,
              `Over target in ${r.over} of ${r.targeted} ${r.months.some((c) => c.period && c.period.periodMonths > 1) ? "periods" : "months"}.`,
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        {/* Every target together, month by month: monthly figures all, so they add up. */}
        <tr>
          <th scope="row" className="pr-1 pt-1 text-left align-middle text-sm font-medium">
            All targets
          </th>
          {columns.map((c, ci) => {
            const id = `all:${c.month}`;
            const overLine = `${c.over} of ${c.targets} target${c.targets === 1 ? "" : "s"} over.`;
            return (
              <td
                key={c.month}
                className="relative h-9 p-0 pt-1"
                {...(c.total ? cellProps(id, ci, totalBody(`All targets · ${monthName(c.month, "long")}`, c.total, overLine)) : {})}
              >
                {c.total ? (
                  <>
                    <Link
                      href={c.href}
                      aria-label={`All targets, ${monthName(c.month, "long")}: ${formatCents(c.total.spentCents)} of ${formatCents(c.total.targetCents)}, ${underOver(c.total.spentCents, c.total.targetCents)}. ${overLine}`}
                      {...triggerProps(id, ci, totalBody(`All targets · ${monthName(c.month, "long")}`, c.total, overLine))}
                      className={`flex h-full items-center justify-center rounded-sm tabular-nums hover:ring-1 hover:ring-foreground/50 focus-visible:outline-2 focus-visible:outline-ring ${shade(c.total.spentCents, c.total.targetCents)}`}
                    >
                      <span aria-hidden className="hidden text-[10px] md:inline">
                        {compactDiff(c.total.spentCents - c.total.targetCents)}
                      </span>
                    </Link>
                    {bubble(id)}
                  </>
                ) : (
                  <span className="flex h-full items-center justify-center rounded-sm bg-muted/50 text-muted-foreground">
                    <span aria-hidden className="hidden text-[10px] md:inline">
                      –
                    </span>
                  </span>
                )}
              </td>
            );
          })}
          {totalCell(
            "all:total",
            "All targets, these 12 months",
            grand,
            `${rows.reduce((s, r) => s + r.over, 0)} of ${rows.reduce((s, r) => s + r.targeted, 0)} target-months over.`,
            true,
          )}
        </tr>
        {pay ? (
          <>
            {/* Where the saving falls (#138): pay as it landed, and pay less spending. */}
            <tr>
              <th scope="row" className="pr-1 pt-2 text-left align-middle text-sm font-normal">
                Net pay
              </th>
              {pay.map((p) => (
                <td key={p.month} className="h-7 p-0 pt-2 text-center text-[10px] tabular-nums text-muted-foreground">
                  <span className="sr-only">{monthName(p.month, "long")}: </span>
                  {p.payCents === null ? <span aria-label="no pay recorded">–</span> : <span className="hidden md:inline">{compact(p.payCents)}</span>}
                  {p.payCents !== null ? <span className="md:hidden" aria-hidden>•</span> : null}
                </td>
              ))}
              <td className="h-7 p-0 pl-1 pt-2 text-center text-[10px] font-medium tabular-nums">{payTotals ? compact(payTotals.netPayCents) : ""}</td>
            </tr>
            <tr>
              <th scope="row" className="pr-1 text-left align-middle text-sm font-normal">
                Saved
              </th>
              {pay.map((p) => (
                <td key={p.month} className={`h-7 p-0 text-center text-[10px] tabular-nums ${p.savedCents !== null && p.savedCents < 0 ? "text-negative" : ""}`}>
                  <span className="sr-only">{monthName(p.month, "long")}: </span>
                  {p.savedCents === null ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    <>
                      <span className="hidden md:inline">{compactDiff(p.savedCents)}</span>
                      <span className="md:hidden">{p.savedCents < 0 ? "−" : "+"}</span>
                    </>
                  )}
                </td>
              ))}
              <td className={`h-7 p-0 pl-1 text-center text-[10px] font-medium tabular-nums ${payTotals && payTotals.savedCents < 0 ? "text-negative" : ""}`}>
                {payTotals ? compactDiff(payTotals.savedCents) : ""}
              </td>
            </tr>
          </>
        ) : null}
      </tfoot>
    </table>
  );
}
