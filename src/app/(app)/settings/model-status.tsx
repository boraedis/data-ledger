"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { EvalSummary } from "@/lib/model/evaluate";
import type { ModelStatus } from "@/lib/model/status";
import { evaluateOnHistory, testModel } from "./model-actions";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

type EvalView = { summary: EvalSummary; recommended: number | null } | null;

function pct(n: number, of: number) {
  return of ? `${Math.round((100 * n) / of)}%` : "—";
}

function EvalResults({ evaluation, threshold }: { evaluation: EvalView; threshold: number }) {
  if (!evaluation) {
    return <p className="text-muted-foreground">Not evaluated on your history yet.</p>;
  }
  const { summary: e, recommended } = evaluation;
  return (
    <div className="space-y-1">
      <p>
        Last evaluated {when.format(e.createdAt)} on {e.sampleSize} of your categorized transactions: {e.correct} right,{" "}
        {e.wrong} wrong, {e.abstained} &quot;don&apos;t know&quot;.
      </p>
      <table className="text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pr-4 font-normal">Auto-apply at</th>
            <th className="pr-4 font-normal">Would apply</th>
            <th className="font-normal">Of those, right</th>
          </tr>
        </thead>
        <tbody>
          {e.thresholds.map((t) => (
            <tr key={t.threshold} className={t.threshold === threshold ? "font-medium" : undefined}>
              <td className="pr-4">
                ≥{Math.round(t.threshold * 100)}%{t.threshold === threshold ? " (current)" : ""}
              </td>
              <td className="pr-4">
                {t.applied} ({pct(t.applied, e.sampleSize)})
              </td>
              <td>
                {t.correct} ({pct(t.correct, t.applied)})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground">
        {recommended === null
          ? "No threshold was free of wrong answers in this sample; keep it high."
          : `Lowest threshold with no wrong auto-applied answers here: ${Math.round(recommended * 100)}%.`}{" "}
        Current: {Math.round(threshold * 100)}% (MODEL_AUTO_APPLY_THRESHOLD).
      </p>
    </div>
  );
}

export function ModelStatusPanel({ status, evaluation, threshold }: { status: ModelStatus; evaluation: EvalView; threshold: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof testModel>> | null>(null);
  const [evalPending, startEval] = useTransition();
  const [evalError, setEvalError] = useState<string | null>(null);
  const r = status.recent;

  if (!status.configured) {
    return (
      <p className="text-sm text-muted-foreground">
        No model configured. Everything works without one; AI features stay off until MODEL_BASE_URL and
        MODEL_API_KEY are set (see the README, &quot;Model service&quot;).
      </p>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p>
        Self-hosted model at <span className="font-mono">{status.host}</span>
      </p>
      <p className="text-muted-foreground">
        {r.calls === 0
          ? "No calls yet."
          : `Last ${r.calls} calls: ${r.failures} failed · median ${r.medianLatencyMs === null ? "—" : `${(r.medianLatencyMs / 1000).toFixed(1)}s`} · ${r.coldStarts} woke it from idle · latest ${r.lastAt ? when.format(r.lastAt) : "—"}`}
      </p>
      {status.lastFailure ? (
        <p className="text-muted-foreground">
          Last failure: {status.lastFailure.feature}, {when.format(status.lastFailure.at)} — {status.lastFailure.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => setResult(await testModel()))}>
          {pending ? "Waiting for the model…" : "Test model"}
        </Button>
        <span className="text-xs text-muted-foreground">Starts the GPU if it&apos;s asleep, which takes about 3–4 minutes.</span>
      </div>
      {result ? (
        "error" in result ? <p className="text-destructive">{result.error}</p> : <p className="text-muted-foreground">{result.message}</p>
      ) : null}
      <div className="space-y-2 border-t pt-3">
        <p className="font-medium">How well does it categorize your transactions?</p>
        <EvalResults evaluation={evaluation} threshold={threshold} />
        <Button
          size="sm"
          variant="outline"
          disabled={evalPending}
          onClick={() =>
            startEval(async () => {
              const r = await evaluateOnHistory();
              setEvalError("error" in r ? r.error : null);
            })
          }
        >
          {evalPending ? "Evaluating…" : "Evaluate on my history"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Asks the model about up to 30 transactions you&apos;ve already categorized, without telling it the answer. Only the
          scores are kept.
        </p>
        {evalError ? <p className="text-destructive">{evalError}</p> : null}
      </div>
    </div>
  );
}
