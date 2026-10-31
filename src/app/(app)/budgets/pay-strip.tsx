import Link from "next/link";
import { formatCents } from "@/lib/money";

// The month's pay against its budget (#128): net pay, what the targets plan
// to spend, and what's left to save, planned and actual. Each figure has its
// share of net pay. Server-rendered.

export type Figure = { cents: number; percent: number | null };
export type Summary = { netPay: Figure; targets: Figure; expectedSaving: Figure; spent: Figure; actualSaving: Figure };

const stillToCome = (pay: { expectedCount: number; expectedCents: number }) =>
  `incl. ${pay.expectedCount} paycheck${pay.expectedCount === 1 ? "" : "s"} still to come at your recent pace (${formatCents(pay.expectedCents)})`;

/** What actually landed this month, against the typical month (#142). */
function landedNote(pay: { netPayCents: number | null; expectedCount: number; expectedCents: number }, difference: number | null): string {
  if (pay.netPayCents === null || difference === null) return "No pay recorded this month";
  const landed = `${formatCents(pay.netPayCents)} landed${pay.expectedCount ? " (with paychecks still to come)" : ""}`;
  if (difference === 0) return landed;
  return `${landed}: ${difference > 0 ? `+${formatCents(difference)} extra` : `${formatCents(-difference)} short`} this month`;
}

export function Tile({ label, figure, note, signed = false }: { label: string; figure: Figure; note?: string; signed?: boolean }) {
  const negative = signed && figure.cents < 0;
  return (
    <div className="space-y-0.5 rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${negative ? "text-negative" : ""}`}>
        {negative ? "−" : ""}
        {formatCents(Math.abs(figure.cents))}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {figure.percent === null ? "" : `${figure.percent}% of pay`}
        {note ? <span className="block">{note}</span> : null}
      </div>
    </div>
  );
}

export function PayStrip({
  summary,
  pay,
  typical,
  landedDifferenceCents,
  isCurrent,
  uncategorized,
}: {
  summary: Summary | null;
  pay: { recordedCount: number; expectedCount: number; expectedCents: number; netPayCents: number | null };
  typical: { cents: number; paceCents: number; perYear: number } | null;
  landedDifferenceCents: number | null;
  isCurrent: boolean;
  uncategorized: { count: number; cents: number };
}) {
  if (!summary) {
    return (
      <section aria-label="Pay against the budget" className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
        No pay recorded this month. <Link href="/pay" className="underline">Add a pay stub</Link> to see what the budget leaves to save.
      </section>
    );
  }
  const soFar = isCurrent ? " so far" : "";
  return (
    <section aria-label="Pay against the budget" className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile
          label={typical ? "Typical month's pay" : "Net pay"}
          figure={{ ...summary.netPay, percent: null }}
          note={
            typical ? landedNote(pay, landedDifferenceCents) : pay.expectedCount ? stillToCome(pay) : `${pay.recordedCount} pay stub${pay.recordedCount === 1 ? "" : "s"}`
          }
        />
        <Tile label="Total targets" figure={summary.targets} />
        <Tile label="Expected saving" figure={summary.expectedSaving} signed />
        <Tile label={`Spent${soFar}`} figure={summary.spent} />
        <Tile label={`Saved${soFar}`} figure={summary.actualSaving} signed />
      </div>
      <p className="text-xs text-muted-foreground">
        {typical
          ? `A typical month is your recent paycheck (${formatCents(typical.paceCents)}) × ${typical.perYear} a year ÷ 12, so every month is measured the same however many paychecks land in it.`
          : "Net pay is the month's pay stubs by pay date."} Targets count at their monthly share (a twelfth of an annual one). Transfers, savings
        included, are never spending, and neither are deductions taken from a paycheck before it landed.
        {uncategorized.count
          ? ` ${uncategorized.count} uncategorized transaction${uncategorized.count === 1 ? "" : "s"} (${formatCents(uncategorized.cents)} out) ${uncategorized.count === 1 ? "isn't" : "aren't"} in spending until filed.`
          : ""}
      </p>
    </section>
  );
}
