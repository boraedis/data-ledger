import { completeMonths, typicalDays, typicalMonths, type TypicalSlot } from "@/lib/cashflow/typical";
import { flowDays, rollUp, type FlowDay } from "@/lib/cashflow/series";
import { isSpend, type Lookup, type SpendLine } from "@/lib/spending/analyze";

// Spending's pace (#264): what's been spent so far in the period, running,
// against the typical, as Cash flow draws it (#259, #261) and from the same
// helpers (lib/cashflow/typical.ts).
//   - Month, by day: the running total, against the average running total
//     the three months before had by the same day. All three, inside
//     recorded history, or no line.
//   - Year, by month: the running total at each month's end, against the
//     typical months added up, each the same month averaged over up to the
//     three years before that have it whole.
// Spending is the page's own: the lines it totals (expense categories in
// budget accounts, refunds against their day), so the last point is the
// page's total. Days and months still to come have a typical but no actual.
// Client-safe and pure.

export type PacePoint = { date: string; spentCents: number | null; typicalCents: number | null; periods: number };

/** The period's days with what was spent on each; a refund counts against its day. */
export function spendDays(lines: SpendLine[], lookup: Lookup, from: string, to: string): FlowDay[] {
  const outs = lines.filter((l) => isSpend(l, lookup)).map((l) => ({ date: l.date, cents: -l.amountCents }));
  return flowDays(from, to, [], outs);
}

/** A month by day: running spend to `today`, against the typical pace of `priors` (the months before, all of them). */
export function monthPace(days: FlowDay[], priors: FlowDay[][] | null, today: string): PacePoint[] {
  const typical: TypicalSlot[] | null = priors ? typicalDays(priors, days.length) : null;
  let spent = 0;
  return days.map((d, i) => {
    spent += d.outCents;
    return { date: d.date, spentCents: d.date <= today ? spent : null, typicalCents: typical?.[i]?.outCents ?? null, periods: typical?.[i]?.periods ?? 0 };
  });
}

/**
 * A year by month: running spend at each month's end (or today, in the
 * month under way), against the typical months added up. The typical stops
 * at the first month no earlier year has, rather than carry on short.
 */
export function yearPace(year: string, days: FlowDay[], earlier: FlowDay[], { firstDay, today }: { firstDay: string | null; today: string }): PacePoint[] {
  const slots = firstDay ? typicalMonths(year, completeMonths(earlier, { firstDay, today })) : Array<TypicalSlot>(12).fill(null);
  let spent = 0;
  let typical: number | null = 0;
  const months = rollUp(days, "month");
  return months.map((m, i) => {
    spent += m.outCents;
    const slot = slots[i];
    typical = typical === null || !slot ? null : typical + slot.outCents;
    return { date: m.start, spentCents: m.start <= today ? spent : null, typicalCents: typical, periods: slot?.periods ?? 0 };
  });
}
