"use client";

import { ChangePreview, type Change } from "@/components/change-preview";
import { reapplyRule } from "../actions";

// One rule's re-apply preview (#100), on the shared change preview.
export function ReapplyPreview({ ruleId, ruleLabel, changes }: { ruleId: string; ruleLabel: string; changes: Change[] }) {
  return <ChangePreview changes={changes} onApply={(ids) => reapplyRule(ruleId, ids, ruleLabel)} />;
}
