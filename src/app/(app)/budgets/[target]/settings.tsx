"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { scheduleLabel, type HistorySummary } from "@/lib/budgets/format";
import { versionEditFrom, type VersionSpan } from "@/lib/budgets/target-list";
import { formatCents } from "@/lib/money";
import { deleteVersion, endTarget, previewDeleteVersion, previewEndTarget, type BackdateMonth } from "../actions";
import { BackdateWarning, TargetForm, type YearlySuggestion } from "../forms";

// A budget item's target and its history of versions (#174). The target in
// effect is changed from now on (the current period); any version, past ones
// included, can be changed across the months it covered, which goes through
// the backdate review (#137, #143): every month it changes, old and new,
// before anything is saved. Ending the target (#204) picks the month it
// stops from; its history stays, so earlier months keep the target they
// had. An end in a past month shows that same review first, and every
// change is undoable in Activity.

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
  // The version being deleted, with the months it changes, shown before it's deleted (#181).
  const [deleting, setDeleting] = useState<{ key: string; months: BackdateMonth[]; until: string | null } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Ending the target (#204): the month picked, then its review once asked for.
  const [endMonth, setEndMonth] = useState<string | null>(null);
  const [endReview, setEndReview] = useState<{ months: BackdateMonth[]; until: string | null } | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
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
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing("now")}>
              Change target
            </Button>
            {endMonth === null ? (
              <Button size="sm" variant="outline" onClick={() => setEndMonth(currentMonth)}>
                End target
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {current && endMonth !== null ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            From the month you pick there&apos;s no {c.name} target, and its spending counts toward the buffer. Earlier months keep
            the target they had, and a new target later starts fresh.
          </p>
          <label className="flex flex-wrap items-center gap-2">
            <span>Ends from</span>
            <input
              type="month"
              value={endMonth}
              min={c.backdate?.earliestMonth ?? undefined}
              onChange={(e) => {
                setEndMonth(e.target.value);
                setEndReview(null);
                setEndError(null);
              }}
              className="h-9 rounded-md border bg-background px-2"
            />
          </label>
          {endReview ? (
            endReview.months.length ? (
              <BackdateWarning months={endReview.months} until={endReview.until} />
            ) : (
              <p className="text-xs text-muted-foreground">No month so far changes: the target stops from {month(`${endMonth}-01`)}.</p>
            )
          ) : null}
          {endError ? <p className="text-xs text-destructive">{endError}</p> : null}
          <div className="flex gap-2">
            {endReview ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await endTarget(c.categoryId, endMonth, c.name);
                    if (result?.error) return setEndError(result.error);
                    setEndMonth(null);
                    setEndReview(null);
                    setEndError(null);
                  })
                }
              >
                End from {month(`${endMonth}-01`)}
              </Button>
            ) : (
              // Always reviewed first: for a past month it lists the months that lose their target.
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !endMonth}
                onClick={() =>
                  startTransition(async () => {
                    setEndError(null);
                    const preview = await previewEndTarget(c.categoryId, endMonth);
                    if ("error" in preview) return setEndError(preview.error);
                    setEndReview(preview);
                  })
                }
              >
                Review
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setEndMonth(null);
                setEndReview(null);
                setEndError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {/* Removing a whole target is only offered once it has no versions left (#181): each version is deleted on its own. */}

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
            allowRemove={false}
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
          {deleteError && !deleting ? <p className="text-xs text-destructive">{deleteError}</p> : null}
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
                      {deleting?.key === key ? null : (
                        <button
                          type="button"
                          disabled={pending}
                          className="underline underline-offset-2 hover:text-destructive"
                          onClick={() =>
                            startTransition(async () => {
                              setDeleteError(null);
                              const preview = await previewDeleteVersion(c.categoryId, v.effectiveFrom.slice(0, 7));
                              if ("error" in preview) return setDeleteError(preview.error);
                              setDeleting({ key, months: preview.months, until: preview.until });
                            })
                          }
                        >
                          Delete
                        </button>
                      )}
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
                  {deleting?.key === key ? (
                    <div role="alert" className="space-y-2 border-t pt-2">
                      <p className="text-xs text-muted-foreground">
                        Deleting this version gives its months back to the target before it. Later versions keep theirs.
                      </p>
                      <BackdateWarning months={deleting.months} until={deleting.until} />
                      {deleteError ? <p className="text-xs text-destructive">{deleteError}</p> : null}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const result = await deleteVersion(c.categoryId, v.effectiveFrom.slice(0, 7), c.name);
                              if (result?.error) return setDeleteError(result.error);
                              setDeleteError(null);
                              setDeleting(null);
                            })
                          }
                        >
                          Delete this version
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => {
                            setDeleting(null);
                            setDeleteError(null);
                          }}
                        >
                          Back
                        </Button>
                      </div>
                    </div>
                  ) : null}
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
