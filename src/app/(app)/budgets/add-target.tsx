"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { HistorySummary } from "@/lib/budgets/format";
import { TargetForm, type TargetChoice, type YearlySuggestion } from "./forms";

// "Add a target" at the top of the Month view (#174): one button, the form
// opening in place, so adding one never means leaving the month.
export function AddTarget(props: {
  choices: TargetChoice[];
  histories: Record<string, HistorySummary>;
  suggestFrom: Record<string, HistorySummary>;
  windowMonths: number;
  yearly: YearlySuggestion[];
  backdate?: { earliestMonth: string | null; currentMonth: string };
}) {
  const [open, setOpen] = useState(false);
  if (!props.choices.length) return null;
  return open ? (
    <section className="space-y-2 rounded-lg border p-3">
      <h2 className="text-lg font-medium">Add a target</h2>
      <TargetForm {...props} onDone={() => setOpen(false)} />
    </section>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      + Add a target
    </Button>
  );
}
