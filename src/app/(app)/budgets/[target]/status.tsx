import { periodLabel, projectionLabel, scheduleLabel } from "@/lib/budgets/format";
import { paceFor } from "@/lib/budgets/pace-colour";
import { formatCents } from "@/lib/money";
import { PaceBar } from "../pace-bar";

// A budget item's period at a glance (#174): spent against available,
// coloured by pace (#159) with the pace line, the month-end projection
// (#147), and the arithmetic spelled out so rollover and moved budget
// never look like magic. What the Month view's card used to show.

export type ItemStatusTarget = {
  start: string;
  end: string;
  periodMonths: number;
  targetCents: number;
  carryInCents: number;
  adjustmentsCents: number;
  availableCents: number;
  spentCents: number;
  remainingCents: number;
  rollover: boolean;
  elapsedShare: number;
  paceCents: number | null;
  projectedCents: number | null;
  setAsideMonthlyCents: number | null;
  setAsideByNowCents: number | null;
};

export function ItemStatus({ t, inProgress }: { t: ItemStatusTarget; inProgress: boolean }) {
  const over = t.remainingCents < 0;
  const scale = Math.max(t.availableCents, t.spentCents, 1);
  const pace = t.availableCents > 0 ? paceFor(t.availableCents, t.elapsedShare) : null;
  const paceAt = pace !== null ? (pace / scale) * 100 : null;
  const projection = inProgress ? projectionLabel(t) : null;
  const parts = [
    `target ${formatCents(t.targetCents)}`,
    t.carryInCents ? `${t.carryInCents > 0 ? "+" : "−"}${formatCents(Math.abs(t.carryInCents))} rolled over` : null,
    t.adjustmentsCents ? `${t.adjustmentsCents > 0 ? "+" : "−"}${formatCents(Math.abs(t.adjustmentsCents))} moved` : null,
  ].filter(Boolean);

  return (
    <section className="space-y-2 rounded-lg border p-3 text-sm" aria-label="This period">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-xs text-muted-foreground">
          {periodLabel(t.start, t.end)}
          {inProgress ? " so far" : ""} · {scheduleLabel(t.periodMonths)}
          {t.rollover ? " · rolls over" : ""}
        </span>
        <span className="text-lg font-semibold tabular-nums">
          {formatCents(t.spentCents)} <span className="text-sm font-normal text-muted-foreground">of {formatCents(t.availableCents)}</span>
        </span>
      </div>
      <PaceBar spentCents={t.spentCents} budgetCents={t.availableCents} paceCents={pace} className="h-3">
        {over && t.availableCents > 0 ? (
          // Scaled to what was spent when over; this tick marks the limit.
          <div className="absolute -top-1 h-5 w-0.5 bg-foreground" style={{ left: `calc(${(t.availableCents / scale) * 100}% - 1px)` }} />
        ) : null}
        {paceAt !== null ? (
          <div className="absolute -top-1 h-5 border-l-2 border-dotted border-foreground/70" style={{ left: `calc(${Math.min(paceAt, 100)}% - 1px)` }} />
        ) : null}
      </PaceBar>
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span>{parts.join(" ")}</span>
        <span className={over ? "font-medium text-negative" : ""}>
          {over ? `${formatCents(-t.remainingCents)} over` : `${formatCents(t.remainingCents)} left`}
        </span>
      </div>
      {projection ? <p className={`text-xs tabular-nums ${projection.over ? "text-negative" : "text-muted-foreground"}`}>{projection.text}</p> : null}
      {pace !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="mr-1 inline-block h-2 border-l-2 border-dotted border-foreground/70 align-middle" aria-hidden />
          Even pace to date: {formatCents(pace)} ({t.spentCents <= pace ? "within" : "ahead of"} pace)
          {t.setAsideMonthlyCents !== null
            ? ` · Set aside ${formatCents(t.setAsideMonthlyCents)}/month; ${formatCents(t.setAsideByNowCents ?? 0)} by now`
            : ""}
        </p>
      ) : null}
    </section>
  );
}
