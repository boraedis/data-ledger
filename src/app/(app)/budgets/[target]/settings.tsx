"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { scheduleLabel, type HistorySummary } from "@/lib/budgets/format";
import { versionEditFrom, type VersionSpan } from "@/lib/budgets/target-list";
import { formatCents } from "@/lib/money";
import { TargetForm, type YearlySuggestion } from "../forms";

// A budget item's target and its history of versions (#174). The target in
// effect is changed from now on (the current period); any version, past ones
// included, can be changed across the months it covered, which goes through
// the backdate review (#137, #143): every month it changes, old and new,
// before anything is saved.

const month = (date: string) => new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

type Common = {
  categoryId: string | null;
  name: string;
  history?: HistorySummary;
  netHistory?: HistorySummary;
  windowMonths: number;
  backdate?: { earliestMonth: string | null; currentMonth: string };
  yearly: YearlySuggestion[];
};

export function TargetSettings({ current, spans, ...c }: Common & { current: VersionSpan | null; spans: VersionSpan[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const histories = c.history ? { [c.categoryId ?? ""]: c.history } : {};
  const suggestFrom = c.netHistory ? { [c.categoryId ?? ""]: c.netHistory } : {};
  const initialOf = (v: VersionSpan) => ({
    categoryId: c.categoryId,
    name: c.name,
    amountCents: v.amountCents ?? 0,
    periodMonths: v.periodMonths,
    anchorOn: v.anchorOn,
    rollover: v.rollover,
    sinkingFund: v.sinkingFund,
  });
  const currentMonth = c.backdate?.currentMonth ?? "";
  const editFrom = (v: VersionSpan) => versionEditFrom(v, c.backdate?.earliestMonth ?? null, currentMonth);

  return (
    <section className="space-y-3" aria-label="Target">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Target</h2>
        {current && editing !== "now" ? (
          <Button size="sm" variant="outline" onClick={() => setEditing("now")}>
            Change target
          </Button>
        ) : null}
      </div>

      {!current ? (
        // No target in effect: set one up here, with the suggestion and any yearly bill.
        <div className="rounded-lg border p-3">
          <TargetForm
            choices={[{ categoryId: c.categoryId, name: c.name }]}
            histories={histories}
            suggestFrom={suggestFrom}
            windowMonths={c.windowMonths}
            yearly={c.yearly}
            backdate={c.backdate}
          />
        </div>
      ) : editing === "now" ? (
        <div className="rounded-lg border p-3">
          <TargetForm
            initial={initialOf(current)}
            histories={histories}
            suggestFrom={suggestFrom}
            windowMonths={c.windowMonths}
            backdate={c.backdate}
            onDone={() => setEditing(null)}
          />
        </div>
      ) : null}

      {spans.length ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Every version</h3>
          <p className="text-xs text-muted-foreground">
            Oldest first. Changing a version changes the months it covered; you&apos;ll see each month&apos;s old and new target before
            anything is saved.
          </p>
          <ol className="divide-y rounded-lg border text-sm">
            {spans.map((v) => {
              const key = v.effectiveFrom;
              const span = `${month(v.effectiveFrom)} – ${v.until ? month(v.until) : "now"}`;
              // A version that starts in the current period is the current
              // one's own correction, not a change to the past.
              const past = v.effectiveFrom.slice(0, 7) < currentMonth;
              const from = past ? editFrom(v) : v.effectiveFrom.slice(0, 7);
              return (
                <li key={key} className="space-y-2 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="tabular-nums">
                      {v.amountCents === null ? (
                        <span className="text-muted-foreground">Ended from {month(v.effectiveFrom)}</span>
                      ) : (
                        <>
                          <span className="font-medium">{formatCents(v.amountCents)}</span>{" "}
                          <span className="text-muted-foreground">
                            {scheduleLabel(v.periodMonths)}
                            {v.rollover ? " · rolls over" : ""}
                            {v.sinkingFund ? " · sinking fund" : ""}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="flex items-baseline gap-3 text-xs text-muted-foreground">
                      {v.amountCents === null ? null : span}
                      {v.amountCents !== null && editing !== key ? (
                        from === null ? (
                          // The version in effect is changed with "Change target" instead.
                          v.until === null ? null : <span>Before your first transactions</span>
                        ) : (
                          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditing(key)}>
                            Edit
                          </button>
                        )
                      ) : null}
                    </span>
                  </div>
                  {editing === key && v.amountCents !== null && from !== null ? (
                    <div className="border-t pt-2">
                      {past ? (
                        <p className="mb-2 text-xs text-warning">
                          This version is in the past: saving changes the budget for the months it covered, which you&apos;ll review first.
                          {from !== v.effectiveFrom.slice(0, 7)
                            ? ` Your transactions start in ${month(`${from}-01`)}, so the change applies from then; earlier months keep ${formatCents(v.amountCents)}.`
                            : ""}
                        </p>
                      ) : null}
                      <TargetForm
                        initial={initialOf(v)}
                        histories={histories}
                        suggestFrom={suggestFrom}
                        windowMonths={c.windowMonths}
                        backdate={c.backdate}
                        initialFromMonth={past ? from : ""}
                        allowRemove={false}
                        submitLabel="Save this version"
                        onDone={() => setEditing(null)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
