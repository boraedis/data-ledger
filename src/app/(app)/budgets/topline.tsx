import { formatCents } from "@/lib/money";
import { totalsTone } from "@/lib/budgets/pace-colour";
import type { YearTotal } from "@/lib/budgets/year";
import { projectAtEnd } from "@/lib/pace";
import { Tile, type Summary } from "./pay-strip";

// The top of the Month and Year views (#268): one block for the period, the
// same on both, so each figure is in the same place whichever is open.
//
// Two groups, as on the dashboard's boxes (#146): the targets, and pay. The
// targets are the Year view's cells added up (budgets.monthly: months with
// a target, a multi-month target at its even monthly share, budget moved
// counted in its month), the dashboard's own figures, so the three agree.
// Under is coloured by pace (#159, #267), with the projection beside it.
// Pay follows its own rules (all spending against net pay, and on the Year
// view only months with pay), so it's a group of its own rather than mixed
// into the targets' figures.

const TONE_CLASS = { within: "text-positive", ahead: "text-warning", over: "text-negative" } as const;

export type ToplinePay = {
  summary: Summary | null;
  netPayLabel: string;
  netPayNote: string;
  /** How pay is counted, under the tiles. */
  note: React.ReactNode;
  /** In place of the pay tiles when there's no pay. */
  none: React.ReactNode;
};

export function Topline({
  label,
  total,
  share,
  empty,
  note,
  pay,
}: {
  /** The period, for screen readers: "November 2026", "December 2025 – November 2026". */
  label: string;
  total: YearTotal | null;
  /** How far through the period it is, 0–1; 1 once it's over. */
  share: number;
  empty: React.ReactNode;
  /** How the targets are counted, when the page's own figures count them differently. */
  note?: React.ReactNode;
  pay: ToplinePay;
}) {
  const soFar = share < 1 ? " so far" : "";
  const projected = total && share < 1 ? projectAtEnd(total.spentCents, share) : null;
  const tone = total ? totalsTone(total.spentCents, total.targetCents, share) : null;
  const diff = total ? total.targetCents - total.spentCents : 0;
  const s = pay.summary;
  return (
    <section aria-label={`${label} at a glance`} className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {total && tone ? (
          <>
            <Tile label="Targets" figure={{ cents: total.targetCents, percent: null }} />
            <Tile label={`Spent${soFar}`} figure={{ cents: total.spentCents, percent: null }} />
            <Tile label={diff < 0 ? "Over" : "Under"} figure={{ cents: Math.abs(diff), percent: null }} tone={TONE_CLASS[tone.tone]} />
            {/* Where spending ends up at its pace so far; a finished period has nothing to project. */}
            <Tile
              label="Projected"
              figure={{ cents: projected ?? total.spentCents, percent: null }}
              tone={projected !== null && projected > total.targetCents ? "text-negative" : ""}
              note={projected === null ? (share < 1 ? "nothing spent yet" : "final") : projected > total.targetCents ? `${formatCents(projected - total.targetCents)} over` : "within target"}
            />
          </>
        ) : (
          <p className="col-span-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground sm:col-span-4">{empty}</p>
        )}
      </div>
      {/* Colour is never the only cue: yellow says why. */}
      {tone?.headingOverCents != null ? (
        <p className="text-xs text-warning tabular-nums">Under so far, but heading {formatCents(tone.headingOverCents)} over at this pace.</p>
      ) : null}
      {total && note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
        {s ? (
          <>
            <Tile label={pay.netPayLabel} figure={{ ...s.netPay, percent: null }} note={pay.netPayNote} />
            <Tile label="Expected saving" figure={s.expectedSaving} signed />
            <Tile label={`Saved${soFar}`} figure={s.actualSaving} signed />
          </>
        ) : (
          <p className="col-span-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground sm:col-span-3">{pay.none}</p>
        )}
      </div>
      {s ? (
        <p className="text-xs text-muted-foreground">
          {s.targets.percent !== null && s.spent.percent !== null ? `Of pay: targets ${s.targets.percent}%, all spending ${s.spent.percent}%. ` : ""}
          {pay.note}
        </p>
      ) : null}
    </section>
  );
}
