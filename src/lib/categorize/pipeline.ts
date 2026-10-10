import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { categories, rules, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { firstMatchingRule, merchantMemory, type RuleLike } from "@/lib/categorize/match";
import { budgetAccountIds } from "@/operations/accounts";
import { execute } from "@/operations/runtime";

// The categorization pipeline (README, "Categorization pipeline"):
//
//   1. the owner's rules, in priority order
//   2. merchant memory — categorize like this merchant was before
//   3. (later) a self-hosted model with a confidence threshold
//   4. everything else waits in the review inbox
//
// It only fills in uncategorized transactions in accounts that count toward
// budgets, and it never overwrites. Writes go through
// transactions.applyCategories once per rule (actor rule:<id>) and once for
// memory (actor memory), so each is a single undoable entry in Activity.

const BATCH = 2000;

export type CategorizationResult = { byRules: number; byMemory: number; remaining: number };

function describeRule(rule: RuleLike, categoryName: string): string {
  const verb = { equals: "is", contains: "contains", starts_with: "starts with" }[rule.matchType];
  const limits = [
    rule.minAmountCents != null ? `≥ $${(rule.minAmountCents / 100).toFixed(2)}` : null,
    rule.maxAmountCents != null ? `≤ $${(rule.maxAmountCents / 100).toFixed(2)}` : null,
    rule.accountId ? "one account" : null,
  ].filter(Boolean);
  return `Rule: ${rule.matchField} ${verb} "${rule.pattern}"${limits.length ? ` (${limits.join(", ")})` : ""} → ${categoryName}`;
}

async function applyInBatches(db: Db, actor: "memory" | `rule:${string}`, reason: string, assignments: { transactionId: string; categoryId: string }[]) {
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

export async function runCategorization(db: Db): Promise<CategorizationResult> {
  const candidates = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      description: transactions.description,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(isNull(transactions.categoryId), eq(transactions.isSplit, false), inArray(transactions.accountId, budgetAccountIds(db))),
    );
  if (candidates.length === 0) return { byRules: 0, byMemory: 0, remaining: 0 };

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
  for (const txn of unmatched) {
    if (!txn.merchant) continue;
    const verdict = merchantMemory(pastByMerchant.get(txn.merchant) ?? []);
    if (verdict.kind === "apply") memoryAssignments.push({ transactionId: txn.id, categoryId: verdict.categoryId });
  }
  const byMemory = memoryAssignments.length
    ? await applyInBatches(db, "memory", "Merchant memory: same category as this merchant's past transactions", memoryAssignments)
    : 0;

  return { byRules, byMemory, remaining: candidates.length - byRules - byMemory };
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
