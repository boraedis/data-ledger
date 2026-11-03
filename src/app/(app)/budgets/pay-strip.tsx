import Link from "next/link";
import type { ToplinePay } from "./topline";
import { formatCents } from "@/lib/money";

// The month's pay against its budget (#128): net pay and what's left to
// save, planned and actual, each with its share of net pay. Shown in the
// Month view's topline (#268); this works out its labels and notes.
// Server-rendered.

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

export function Tile({ label, figure, note, signed = false, tone = "" }: { label: string; figure: Figure; note?: string; signed?: boolean; tone?: string }) {
  const negative = signed && figure.cents < 0;
  return (
    <div className="space-y-0.5 rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${negative ? "text-negative" : tone}`}>
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

export function monthPay({
  summary,
  pay,
  typical,
  landedDifferenceCents,
  uncategorized,
}: {
  summary: Summary | null;
  pay: { recordedCount: number; expectedCount: number; expectedCents: number; netPayCents: number | null };
  typical: { cents: number; paceCents: number; perYear: number } | null;
  landedDifferenceCents: number | null;
  uncategorized: { count: number; cents: number };
}): ToplinePay {
  return {
    summary,
    netPayLabel: typical ? "Typical month's pay" : "Net pay",
    netPayNote: typical
      ? landedNote(pay, landedDifferenceCents)
      : pay.expectedCount
        ? stillToCome(pay)
        : `${pay.recordedCount} pay stub${pay.recordedCount === 1 ? "" : "s"}`,
    note: (
      <>
        {typical
          ? `A typical month is your recent paycheck (${formatCents(typical.paceCents)}) × ${typical.perYear} a year ÷ 12, so every month is measured the same however many paychecks land in it.`
          : "Net pay is the month's pay stubs by pay date."} Targets count at their monthly share (a twelfth of an annual one). Transfers, savings
        included, are never spending, and neither are deductions taken from a paycheck before it landed.
        {uncategorized.count
          ? ` ${uncategorized.count} uncategorized transaction${uncategorized.count === 1 ? "" : "s"} (${formatCents(uncategorized.cents)} out) ${uncategorized.count === 1 ? "isn't" : "aren't"} in spending until filed.`
          : ""}
      </>
    ),
    none: (
      <>
        No pay recorded this month. <Link href="/pay" className="underline">Add a pay stub</Link> to see what the budget leaves to save.
      </>
    ),
  };
}
