import type { Db } from "@/db/types";
import { hasWork, planTradeGaps } from "@/lib/trades/plan";
import { execute } from "@/operations/runtime";

// Gap drafting after a sync (#320). Apart from ./plan.ts so the operation can
// use the planner without importing the runtime that runs it.

/**
 * After a sync: record baselines and draft any gaps, as one command by the
 * import actor, only when there's something to write. Returns how many
 * drafts were made.
 */
export async function draftTradeGaps(db: Db): Promise<number> {
  const plans = (await planTradeGaps(db)).filter(hasWork);
  if (!plans.length) return 0;
  const drafts = plans.reduce((n, p) => n + p.drafts.length, 0);
  const result = await execute(db, {
    operation: "trades.draftGaps",
    input: {},
    actor: "import",
    reason: drafts ? `Drafted ${drafts} ${drafts === 1 ? "trade" : "trades"} from what the sync reports` : "Recorded where trade drafting starts",
  });
  return result.status === "applied" ? (result.output as { drafted: number }).drafted : 0;
}
