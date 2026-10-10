import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { categories, categorySuggestions, modelEvals, transactions, type ThresholdStat } from "@/db/schema";
import type { Db } from "@/db/types";
import { categoryOptions } from "@/lib/categorize/labels";
import { classifyWithModel, type Classify } from "@/lib/categorize/pipeline";
import { budgetAccountIds } from "@/operations/accounts";

// Evaluates the model against the owner's own categorizations (#6): hide
// the category of transactions the owner, a rule or memory already
// categorized, ask the model, compare. Only aggregate numbers are stored
// (model_evals) — never which transactions were sampled or what the model
// said about them — and nothing from this ever leaves the database
// (AGENTS.md: evals from real history are never committed).

export const EVAL_THRESHOLDS = [0.5, 0.7, 0.8, 0.85, 0.9, 0.95];

export type EvalSummary = typeof modelEvals.$inferSelect;

export async function evaluateModel(
  db: Db,
  { sampleSize = 30, deadline, classify = classifyWithModel }: { sampleSize?: number; deadline?: number; classify?: Classify } = {},
): Promise<EvalSummary> {
  // Ground truth: categorized, unsplit, in budget accounts, and never seen
  // by the model (so it isn't grading its own earlier answers).
  const seenByModel = db.select({ id: categorySuggestions.transactionId }).from(categorySuggestions);
  const sample = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
      experiencedOn: transactions.experiencedOn,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        isNotNull(transactions.categoryId),
        eq(transactions.isSplit, false),
        inArray(transactions.accountId, budgetAccountIds(db)),
        notInArray(transactions.id, seenByModel),
      ),
    )
    .orderBy(desc(transactions.postedOn))
    .limit(sampleSize);
  if (sample.length === 0) throw new Error("Nothing to evaluate against yet: categorize some transactions first");

  const cats = categoryOptions(await db.select().from(categories)).map((o) => ({ id: o.id, label: o.label, kind: o.kind }));
  const started = Date.now();
  const answers = await classify(cats, sample, { deadline, mode: "interactive", db });
  const latencyMs = Date.now() - started;

  let correct = 0;
  let wrong = 0;
  let abstained = 0;
  sample.forEach((t, i) => {
    if (!answers[i].categoryId) abstained++;
    else if (answers[i].categoryId === t.categoryId) correct++;
    else wrong++;
  });
  const thresholds: ThresholdStat[] = EVAL_THRESHOLDS.map((threshold) => {
    const applied = sample.filter((_, i) => answers[i].categoryId && answers[i].confidence >= threshold);
    return {
      threshold,
      applied: applied.length,
      correct: applied.filter((t) => answers[sample.indexOf(t)].categoryId === t.categoryId).length,
    };
  });

  const [row] = await db
    .insert(modelEvals)
    .values({ sampleSize: sample.length, correct, wrong, abstained, thresholds, latencyMs })
    .returning();
  return row;
}

/**
 * The lowest threshold whose auto-applied answers were all right — the
 * most the model can do on its own without a single misfile in the
 * sample. Null when no threshold manages that (or nothing was applied).
 */
export function recommendedThreshold(stats: ThresholdStat[]): number | null {
  const clean = stats.filter((s) => s.applied > 0 && s.correct === s.applied).sort((a, b) => a.threshold - b.threshold);
  return clean[0]?.threshold ?? null;
}

export async function latestEval(db: Db): Promise<EvalSummary | null> {
  const [row] = await db.select().from(modelEvals).orderBy(desc(modelEvals.createdAt)).limit(1);
  return row ?? null;
}
