import { and, asc, count, desc, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { accounts, categories, categorySuggestions, payStubDeposits, payStubs, rules, transactions } from "@/db/schema";
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
import type { AccountKind } from "@/lib/account-kinds";
import { TRANSFER_PASSES, findTransferPairs } from "@/lib/investments/transfers";
import { findMatches } from "@/lib/provisional/match";
import { openDeposits } from "@/operations/pay";
import { execute } from "@/operations/runtime";
import { awaitingCategory } from "@/operations/transactions";

// The categorization pipeline (README, "Categorization pipeline"):
//
//   0. transfer matching (#24): money moved between a cash account and an
//      investment account is paired, not categorized — it's neither
//      spending nor income, so it leaves the queue before any rule sees it
//   1. the owner's rules, in priority order — the only step that
//      categorizes on its own
//   2. merchant memory — a suggestion: this merchant's usual category
//   3. the self-hosted model (#39), only for what 1 and 2 left, and only when
//      a caller opts in (the nightly sync, the inbox's "Ask the model") —
//      its answers are suggestions too
//   4. everything else waits in the review inbox, suggestions pre-selected
//      for the owner to confirm (#86)
//
// Only the owner's explicit rules apply automatically (#86): memory and
// the model used to apply their confident answers, logged and undoable,
// but nothing asked first. Now they suggest, and confirming is one tap,
// or one for a whole set.
//
// It only fills in uncategorized transactions in accounts that count toward
// budgets, and it never overwrites. Writes go through
// transactions.applyCategories once per rule (actor rule:<id>), so each is
// a single undoable entry in Activity.

const BATCH = 2000;

export type CategorizationResult = {
  // Transfer pairs matched this run (each takes two transactions).
  transfers?: number;
  // Provisional transactions matched to their synced versions (#30).
  provisional?: number;
  // Pay stubs linked to the deposit of their net pay (#60).
  payStubs?: number;
  byRules: number;
  // Transactions the model looked at this run; each became a suggestion.
  modelSeen: number;
  // Transactions still waiting for the model after this run (it ran out of
  // time or hit its limit). Zero when there's nothing left for it.
  modelPending: number;
  remaining: number;
  // Set when the model step was attempted but couldn't finish (unreachable,
  // still starting, out of time). Everything it didn't reach stays in the
  // inbox and is tried again next time.
  modelError?: string;
};

// Confidence at or above which the model's suggestion counts as confident:
// the inbox's "select the confident ones" for confirming a set at once
// (#86). Nothing is applied on it. Settings → Model → evaluation says how
// many confident answers would have been wrong, as a reference point.
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

async function applyInBatches(db: Db, actor: `rule:${string}`, reason: string, assignments: { transactionId: string; categoryId: string }[]) {
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

/**
 * Before anything else: provisional transactions (from purchase alerts)
 * meet the synced transactions the bank has since reported for them, as
 * one undoable "matcher" command. It runs first so the category the owner
 * gave a purchase from its notification carries over before rules or the
 * model look at the synced row.
 */
export async function matchProvisionalStep(db: Db): Promise<number> {
  const select = { id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, postedOn: transactions.postedOn, createdAt: transactions.createdAt };
  const provisional = await db.select(select).from(transactions).where(isNotNull(transactions.provisionalSource));
  if (provisional.length === 0) return 0;
  const synced = await db
    .select(select)
    .from(transactions)
    .where(
      and(
        isNull(transactions.provisionalSource),
        eq(transactions.pending, false),
        inArray(transactions.accountId, [...new Set(provisional.map((p) => p.accountId))]),
        inArray(transactions.amountCents, [...new Set(provisional.map((p) => p.amountCents))]),
      ),
    );
  const pairs = findMatches(provisional, synced);
  if (pairs.length === 0) return 0;
  const result = await execute(db, {
    operation: "transactions.matchProvisional",
    actor: "matcher",
    reason: `Matched ${pairs.length} purchase alert${pairs.length === 1 ? "" : "s"} to what the bank reported`,
    input: { pairs },
  });
  return result.status === "applied" ? (result.output as { matched: number }).matched : 0;
}

/**
 * A pay stub entered before payday meets its deposits once the bank posts
 * them (#60): one deposit of exactly the net, or pay split across accounts
 * (#91), near the pay date, and the only way that fits. Ambiguous ones are
 * left for the owner to pick on the Pay page.
 */
export async function linkPayStubsStep(db: Db): Promise<number> {
  const linkedStubs = db.select({ id: payStubDeposits.payStubId }).from(payStubDeposits);
  const stubs = await db.select().from(payStubs).where(notInArray(payStubs.id, linkedStubs));
  let linked = 0;
  const claimed = new Set<string>();
  for (const stub of stubs) {
    const matches = (await openDeposits(db, stub, stub.id)).filter((m) => m.every((d) => !claimed.has(d.id)));
    if (matches.length !== 1) continue;
    const ids = matches[0].map((d) => d.id);
    for (const id of ids) claimed.add(id);
    const result = await execute(db, {
      operation: "payStubs.linkDeposit",
      actor: "matcher",
      reason: `Linked the ${stub.payDate} pay stub to its ${ids.length === 1 ? "deposit" : `${ids.length} deposits`}`,
      input: { payStubId: stub.id, depositTransactionIds: ids },
    });
    if (result.status === "applied") linked++;
  }
  return linked;
}

/**
 * Step 0: pair unambiguous transfers between the owner's own accounts, as
 * one undoable "matcher" command per kind, so the same money is never
 * counted twice (#24, and card payments since):
 *   - cash ↔ investment: contributions and withdrawals
 *   - cash → credit card or loan: a payment, which covers spending already
 *     counted when it was charged
 *   - cash ↔ cash: checking to savings, a payment app cashing out
 * Pending rows, rows already paired, and rows the owner said aren't
 * transfers are left alone. A side must be uncategorized or filed under a
 * transfer category: if the owner filed it as spending or income, that
 * stands. Each side pairs only with its single closest match.
 */
export async function matchTransfersStep(db: Db): Promise<number> {
  const transferCategories = db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer"));
  const open = and(
    eq(transactions.pending, false),
    isNull(transactions.provisionalSource),
    isNull(transactions.transferPairId),
    eq(transactions.transferRejected, false),
    eq(transactions.isSplit, false),
    or(isNull(transactions.categoryId), inArray(transactions.categoryId, transferCategories)),
  );
  const select = { id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, postedOn: transactions.postedOn };
  const rowsIn = (kinds: readonly AccountKind[]) =>
    db
      .select(select)
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(open, inArray(accounts.type, [...kinds])));

  let matched = 0;
  for (const pass of TRANSFER_PASSES) {
    // Re-read each time: what one pass paired is no longer open.
    const [a, b] = await Promise.all([rowsIn(pass.from), rowsIn(pass.to)]);
    // One-way passes pair money out of the first with money into the second.
    const sources = pass.outOnly ? a.filter((t) => t.amountCents < 0) : a;
    const targets = pass.outOnly ? b.filter((t) => t.amountCents > 0) : b;
    const pairs = findTransferPairs(sources, targets);
    if (pairs.length === 0) continue;
    const result = await execute(db, {
      operation: "transactions.matchTransfers",
      actor: "matcher",
      reason: `Matched ${pairs.length} transfer${pairs.length === 1 ? "" : "s"} ${pass.what}`,
      input: { pairs },
    });
    if (result.status === "applied") matched += (result.output as { matched: number }).matched;
  }
  return matched;
}

export async function runCategorization(
  db: Db,
  { model }: { model?: ModelStepOptions | false } = {},
): Promise<CategorizationResult> {
  const provisional = await matchProvisionalStep(db);
  const payStubsLinked = await linkPayStubsStep(db);
  const transfers = await matchTransfersStep(db);
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
    .where(awaitingCategory(db));
  if (candidates.length === 0) return { provisional, payStubs: payStubsLinked, transfers, byRules: 0, modelSeen: 0, modelPending: 0, remaining: 0 };

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

  // 2. Merchant memory, over what's already categorized (newest first). It
  // suggests (the inbox reads it the same way, transactions.inbox); here it
  // only decides what the model needn't be asked: a merchant with history
  // already has the owner's own answer to offer.
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
  const forModel = unmatched.filter((txn) => !txn.merchant || merchantMemory(pastByMerchant.get(txn.merchant) ?? []).kind === "none");

  // 3. The model, only if asked for and configured.
  const modelResult = model && modelIsConfigured() ? await modelStep(db, forModel, model) : { seen: 0, pending: 0 };

  return {
    provisional,
    payStubs: payStubsLinked,
    transfers,
    byRules,
    modelSeen: modelResult.seen,
    modelPending: modelResult.pending,
    remaining: candidates.length - byRules,
    ...("error" in modelResult ? { modelError: modelResult.error } : {}),
  };
}

async function modelStep(
  db: Db,
  txns: { id: string; description: string; amountCents: number; postedOn: string; experiencedOn: string | null }[],
  options: ModelStepOptions,
): Promise<{ seen: number; pending: number; error?: string }> {
  // The model sees each transaction once: whatever it said is recorded as a
  // suggestion (even "none"), and those aren't sent again.
  const asked = txns.length
    ? await db
        .select({ id: categorySuggestions.transactionId })
        .from(categorySuggestions)
        .where(inArray(categorySuggestions.transactionId, txns.map((t) => t.id)))
    : [];
  const askedIds = new Set(asked.map((a) => a.id));
  const unasked = txns.filter((t) => !askedIds.has(t.id)).sort((a, b) => b.postedOn.localeCompare(a.postedOn));
  const queue = unasked.slice(0, options.limit ?? 200);
  if (queue.length === 0) return { seen: 0, pending: 0 };
  // Too little time left even to wait for an answer: skip quietly and let
  // the next run (or the inbox button) pick these up.
  if (options.deadline && options.deadline - Date.now() < 30_000) return { seen: 0, pending: unasked.length };

  const cats: ClassifierCategory[] = categoryOptions(await db.select().from(categories)).map((o) => ({
    id: o.id,
    label: o.label,
    kind: o.kind,
  }));
  if (cats.length === 0) return { seen: 0, pending: 0 };

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
  if (results.length === 0) return { seen: 0, pending: unasked.length, ...(error ? { error } : {}) };

  // Every answer is a suggestion for the owner to confirm (#86), however
  // confident.
  await execute(db, {
    operation: "transactions.recordSuggestions",
    actor: "model",
    reason: "Model suggestions for the inbox",
    input: { suggestions: results },
  });
  return { seen: results.length, pending: unasked.length - results.length, ...(error ? { error } : {}) };
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
