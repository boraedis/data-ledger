import Link from "next/link";
import { formatCents } from "@/lib/money";

// A target's last few months as bars against its target (#107), so creep
// and seasonal spikes show where a single month's card can't.
//
// Plain HTML rather than SVG: each bar is a link to that month's budgets
// view, sized by percentage, so it stays crisp at any card width without
// measuring, and works without JavaScript.
//
// - Bars in the accent; over that month's target in the card's own
//   over-budget color. The dashed target line says the same thing, so
//   it isn't color alone.
// - Months before the target existed are faded and have no line: they show
//   what it would have covered, not what it was held to.
// - A month with nothing spent keeps its column with a hairline at the
//   baseline, so it reads as $0 rather than missing.

export type Bar = {
  month: string; // first of the month
  spentCents: number;
  targetCents: number | null;
  href: string;
};

const monthName = (month: string, style: "short" | "long") =>
  new Date(`${month}T00:00:00Z`).toLocaleDateString("en-US", { month: style, ...(style === "long" ? { year: "numeric" } : {}), timeZone: "UTC" });

function describe(b: Bar): string {
  const spent = b.spentCents < 0 ? `${formatCents(-b.spentCents)} refunded` : `${formatCents(b.spentCents)} spent`;
  if (b.targetCents === null) return `${monthName(b.month, "long")}: ${spent}, before this target`;
  const over = b.spentCents > b.targetCents ? `, ${formatCents(b.spentCents - b.targetCents)} over` : "";
  return `${monthName(b.month, "long")}: ${spent} of ${formatCents(b.targetCents)}${over}`;
}

/** The text summary screen readers get in place of the picture. */
function summary(bars: Bar[], partialMonth: string | null): string {
  const targeted = bars.filter((b) => b.targetCents !== null);
  const over = targeted.filter((b) => b.spentCents > b.targetCents!);
  const highest = bars.reduce((a, b) => (b.spentCents > a.spentCents ? b : a), bars[0]);
  const parts = [
    `Last ${bars.length} months, ${monthName(bars[0].month, "long")} to ${monthName(bars.at(-1)!.month, "long")}${partialMonth ? " (so far)" : ""}.`,
    targeted.length ? `Over target in ${over.length} of ${targeted.length} ${targeted.length === 1 ? "month" : "months"}.` : null,
    highest.spentCents > 0 ? `Highest: ${monthName(highest.month, "long")}, ${formatCents(highest.spentCents)}.` : "Nothing spent.",
  ];
  return parts.filter(Boolean).join(" ");
}

export function MonthBars({ bars, viewedMonth, partialMonth }: { bars: Bar[]; viewedMonth: string; partialMonth: string | null }) {
  if (bars.length === 0) return null;
  const scale = Math.max(1, ...bars.map((b) => Math.max(b.spentCents, b.targetCents ?? 0)));
  const pct = (cents: number) => `${(Math.max(0, cents) / scale) * 100}%`;

  return (
    <figure className="space-y-1">
      <figcaption className="sr-only">{summary(bars, partialMonth)}</figcaption>
      <ol className="flex h-14 items-stretch border-b border-border">
        {bars.map((b) => {
          const over = b.targetCents !== null && b.spentCents > b.targetCents;
          const label = describe(b) + (b.month === partialMonth ? " so far" : "");
          return (
            <li key={b.month} className="relative flex-1">
              <Link
                href={b.href}
                aria-label={label}
                title={label}
                aria-current={b.month === viewedMonth ? "page" : undefined}
                // The whole column is the target, not just the bar: a small
                // month is still easy to tap.
                className="group flex h-full items-end justify-center rounded-sm px-[3px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span
                  className={`w-full max-w-8 rounded-t-[4px] ${
                    b.spentCents <= 0 ? "" : over ? "bg-negative/80" : b.targetCents === null ? "bg-primary/35" : "bg-primary"
                  } ${b.month === partialMonth ? "opacity-70" : ""}`}
                  style={{ height: b.spentCents <= 0 ? 0 : `max(2px, ${pct(b.spentCents)})` }}
                />
              </Link>
              {b.targetCents !== null ? (
                // Each month's own target, so a change shows as a step.
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/70"
                  style={{ bottom: pct(b.targetCents) }}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <ol aria-hidden className="flex text-[10px] text-muted-foreground">
        {bars.map((b) => (
          <li key={b.month} className={`flex-1 text-center ${b.month === viewedMonth ? "font-medium text-foreground" : ""}`}>
            {monthName(b.month, "short")}
          </li>
        ))}
      </ol>
    </figure>
  );
}
