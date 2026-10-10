"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ModelStatus } from "@/lib/model/status";
import { testModel } from "./model-actions";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function ModelStatusPanel({ status }: { status: ModelStatus }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof testModel>> | null>(null);
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
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => setResult(await testModel()))}>
          {pending ? "Waiting for the model…" : "Test model"}
        </Button>
        <span className="text-xs text-muted-foreground">Starts the GPU if it&apos;s asleep, which can take a minute or two.</span>
      </div>
      {result ? (
        "error" in result ? <p className="text-destructive">{result.error}</p> : <p className="text-muted-foreground">{result.message}</p>
      ) : null}
    </div>
  );
}
