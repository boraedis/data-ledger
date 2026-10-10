import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { categories, categorySuggestions, rules, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  classifierRequest,
  parseClassifierReply,
  type Classification,
  type ClassifierCategory,
  type ClassifierInput,
} from "@/lib/categorize/classify";
import { categoryOptions } from "@/lib/categorize/labels";
import { firstMatchingRule, merchantMemory, type RuleLike } from "@/lib/categorize/match";
import { chat, modelIsConfigured } from "@/lib/model/client";
import { budgetAccountIds } from "@/operations/accounts";
import { execute } from "@/operations/runtime";

// The categorization pipeline (README, "Categorization pipeline"):
//
//   1. the owner's rules, in priority order
//   2. merchant memory — categorize like this merchant was before
//   3. the self-hosted model (#39), only for what 1 and 2 left, and only when
//      a caller opts in (the nightly sync, the inbox's "Ask the model") —
//      confident answers are applied, the rest become inbox suggestions
//   4. everything else waits in the review inbox
//
// It only fills in uncategorized transactions in accounts that count toward
// budgets, and it never overwrites. Writes go through
// transactions.applyCategories once per rule (actor rule:<id>) and once for
// memory (actor memory), so each is a single undoable entry in Activity.

const BATCH = 2000;

export type CategorizationResult = {
  byRules: number;
  byMemory: number;
  byModel: number;
  // Transactions the model looked at this run (applied or suggested).
  modelSeen: number;
  remaining: number;
  // Set when the model step was attempted but couldn't finish (unreachable,
  // still starting, out of time). Everything it didn't reach stays in the
  // inbox and is tried again next time.
  modelError?: string;
};

// Confidence at or above which the model's answer is applied rather than
// suggested. High on purpose: a wrong category applied silently is worse
// than one more inbox item. Tune it from Settings → Model → evaluation.
export function autoApplyThreshold(): number {
  const raw = Number(process.env.MODEL_AUTO_APPLY_THRESHOLD);
  return raw > 0 && raw <= 1 ? raw : 0.9;
}

export type Classify = (
  categories: ClassifierCategory[],
  txns: ClassifierInput[],
  options: { deadline?: number; mode: "background" | "interactive"; db: Db },
) => Promise<Classification[]>;

/** The real classifier: one model call per batch through the gateway. */
export const classifyWithModel: Classify = async (cats, txns, { deadline, mode, db }) => {
  const { messages, jsonSchema } = classifierRequest(cats, txns);
  const reply = await chat({ feature: "categorize", messages, jsonSchema, mode, deadline, maxTokens: 64 * txns.length + 256 }, { db });
  return parseClassifierReply(reply.content, cats, txns.length);
};

export type ModelStepOptions = {
  classify?: Classify;
  deadline?: number;
  mode?: "background" | "interactive";
  // Most transactions to send in one run; the rest wait for the next.
  limit?: number;
};

// Thirty per call keeps each reply well inside the token budget and one
// batch to well under a minute once the model is warm.
const MODEL_BATCH = 30;
// Don't start a batch that can't finish before the deadline.
const MIN_MS_FOR_A_BATCH = 75_000;

function describeRule(rule: RuleLike, categoryName: string): string {
  const verb = { equals: "is", contains: "contains", starts_with: "starts with" }[rule.matchType];
  const limits = [
    rule.minAmountCents != null ? `≥ $${(rule.minAmountCents / 100).toFixed(2)}` : null,
    rule.maxAmountCents != null ? `≤ $${(rule.maxAmountCents / 100).toFixed(2)}` : null,
    rule.accountId ? "one account" : null,
  ].filter(Boolean);
  return `Rule: ${rule.matchField} ${verb} "${rule.pattern}"${limits.length ? ` (${limits.join(", ")})` : ""} → ${categoryName}`;
}

async function applyInBatches(db: Db, actor: "memory" | "model" | `rule:${string}`, reason: string, assignments: { transactionId: string; categoryId: string }[]) {
  let applied = 0;
  for (let i = 0; i < assignments.length; i += BATCH) {
    const result = await execute(db, {
      operation: "transactions.applyCategories",
      actor,
      reason,
      input: { assignments: assignments.slice(i, i + BATCH) },
    });
    if (result.status === "applied") applied += (result.output as { applied: number }).applied;
  }
  return applied;
}

export async function runCategorization(
  db: Db,
  { model }: { model?: ModelStepOptions | false } = {},
): Promise<CategorizationResult> {
  const candidates = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      description: transactions.description,
      merchant: transactions.merchant,
      postedOn: transactions.postedOn,
      experiencedOn: transactions.experiencedOn,
    })
    .from(transactions)
    .where(
      and(isNull(transactions.categoryId), eq(transactions.isSplit, false), inArray(transactions.accountId, budgetAccountIds(db))),
    );
  if (candidates.length === 0) return { byRules: 0, byMemory: 0, byModel: 0, modelSeen: 0, remaining: 0 };

  // 1. Rules.
  const activeRules = await db
    .select({ rule: rules, categoryName: categories.name })
    .from(rules)
    .innerJoin(categories, eq(categories.id, rules.categoryId))
    .where(eq(rules.enabled, true))
    .orderBy(asc(rules.priority), asc(rules.createdAt));
  const ruleList = activeRules.map((r) => r.rule);

  const byRule = new Map<string, { transactionId: string; categoryId: string }[]>();
  const unmatched: typeof candidates = [];
  for (const txn of candidates) {
    const rule = firstMatchingRule(ruleList, txn);
    if (rule) byRule.set(rule.id, [...(byRule.get(rule.id) ?? []), { transactionId: txn.id, categoryId: rule.categoryId }]);
    else unmatched.push(txn);
  }

  let byRules = 0;
  for (const { rule, categoryName } of activeRules) {
    const assignments = byRule.get(rule.id);
    if (assignments) byRules += await applyInBatches(db, `rule:${rule.id}`, describeRule(rule, categoryName), assignments);
  }

  // 2. Merchant memory, over what's already categorized (newest first).
  const merchants = [...new Set(unmatched.map((t) => t.merchant).filter((m): m is string => Boolean(m)))];
  const history = merchants.length
    ? await db
        .select({ merchant: transactions.merchant, categoryId: transactions.categoryId })
        .from(transactions)
        .where(and(inArray(transactions.merchant, merchants), isNotNull(transactions.categoryId)))
        .orderBy(desc(transactions.postedOn), desc(transactions.createdAt))
    : [];
  const pastByMerchant = new Map<string, string[]>();
  for (const h of history) pastByMerchant.set(h.merchant!, [...(pastByMerchant.get(h.merchant!) ?? []), h.categoryId!]);

  const memoryAssignments: { transactionId: string; categoryId: string }[] = [];
  const forModel: typeof unmatched = [];
  for (const txn of unmatched) {
    const verdict = txn.merchant ? merchantMemory(pastByMerchant.get(txn.merchant) ?? []) : { kind: "none" as const };
    if (verdict.kind === "apply") memoryAssignments.push({ transactionId: txn.id, categoryId: verdict.categoryId });
    // Mixed history is the owner's call, not the model's: those go to the
    // inbox with memory's suggestion.
    else if (verdict.kind === "none") forModel.push(txn);
  }
  const byMemory = memoryAssignments.length
    ? await applyInBatches(db, "memory", "Merchant memory: same category as this merchant's past transactions", memoryAssignments)
    : 0;

  // 3. The model, only if asked for and configured.
  const modelResult = model && modelIsConfigured() ? await modelStep(db, forModel, model) : { byModel: 0, seen: 0 };

  return {
    byRules,
    byMemory,
    byModel: modelResult.byModel,
    modelSeen: modelResult.seen,
    remaining: candidates.length - byRules - byMemory - modelResult.byModel,
    ...("error" in modelResult ? { modelError: modelResult.error } : {}),
  };
}

async function modelStep(
  db: Db,
  txns: { id: string; description: string; amountCents: number; postedOn: string; experiencedOn: string | null }[],
  options: ModelStepOptions,
): Promise<{ byModel: number; seen: number; error?: string }> {
  // The model sees each transaction once: whatever it said is recorded as a
  // suggestion (even "none"), and those aren't sent again.
  const asked = txns.length
    ? await db
        .select({ id: categorySuggestions.transactionId })
        .from(categorySuggestions)
        .where(inArray(categorySuggestions.transactionId, txns.map((t) => t.id)))
    : [];
  const askedIds = new Set(asked.map((a) => a.id));
  const queue = txns
    .filter((t) => !askedIds.has(t.id))
    .sort((a, b) => b.postedOn.localeCompare(a.postedOn))
    .slice(0, options.limit ?? 200);
  if (queue.length === 0) return { byModel: 0, seen: 0 };
  // Too little time left even to wait for an answer: skip quietly and let
  // the next run (or the inbox button) pick these up.
  if (options.deadline && options.deadline - Date.now() < 30_000) return { byModel: 0, seen: 0 };

  const cats: ClassifierCategory[] = categoryOptions(await db.select().from(categories)).map((o) => ({
    id: o.id,
    label: o.label,
    kind: o.kind,
  }));
  if (cats.length === 0) return { byModel: 0, seen: 0 };

  const classify = options.classify ?? classifyWithModel;
  const mode = options.mode ?? "background";
  const results: { transactionId: string; categoryId: string | null; confidence: number }[] = [];
  let error: string | undefined;
  for (let i = 0; i < queue.length; i += MODEL_BATCH) {
    // The first batch may spend its time waiting out a cold start; later
    // ones only start if there's room to finish.
    if (i > 0 && options.deadline && options.deadline - Date.now() < MIN_MS_FOR_A_BATCH) break;
    const batch = queue.slice(i, i + MODEL_BATCH);
    try {
      const answers = await classify(cats, batch, { deadline: options.deadline, mode, db });
      batch.forEach((t, j) => results.push({ transactionId: t.id, ...answers[j] }));
    } catch (e) {
      error = e instanceof Error ? e.message : "The model call failed";
      break;
    }
  }
  if (results.length === 0) return { byModel: 0, seen: 0, ...(error ? { error } : {}) };

  const threshold = autoApplyThreshold();
  const confident = results
    .filter((r) => r.categoryId && r.confidence >= threshold)
    .map((r) => ({ transactionId: r.transactionId, categoryId: r.categoryId! }));
  const byModel = confident.length
    ? await applyInBatches(db, "model", `Model: confident categorizations (≥${Math.round(threshold * 100)}% confidence)`, confident)
    : 0;
  await execute(db, {
    operation: "transactions.recordSuggestions",
    actor: "model",
    reason: "Model suggestions for the inbox",
    input: { suggestions: results },
  });
  return { byModel, seen: results.length, ...(error ? { error } : {}) };
}

/** Fills in merchant names for older transactions, if any lack one. Logged only when there's work. */
export async function backfillMerchantsIfNeeded(db: Db): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(transactions).where(isNull(transactions.merchant));
  if (value === 0) return 0;
  const result = await execute(db, {
    operation: "transactions.backfillMerchants",
    actor: "import",
    reason: "Derive merchant names for older transactions",
    input: {},
  });
  return result.status === "applied" ? (result.output as { filled: number }).filled : 0;
}
