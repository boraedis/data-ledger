import { z } from "zod";
import { createManualAccount, deleteManualAccount, listAccounts, setManualValue, updateAccount } from "@/operations/accounts";
import { budgetStatus, listTargets, rebalance, removeTarget, setTarget } from "@/operations/budgets";
import { archiveGoal, createGoal, listGoals, updateGoal } from "@/operations/goals";
import { applySnapshot } from "@/operations/import";
import { createPayStub, deletePayStub, linkPayDeposit, listPayStubs, payDepositCandidates, updatePayStub } from "@/operations/pay";
import { categoryChoices } from "@/operations/choices";
import { setTaxAssumptions, taxEstimate } from "@/operations/taxes";
import { createProvisional, discardProvisional, listProvisional, matchProvisional } from "@/operations/provisional";
import { cancelRecurring, dismissAlert, listAlerts, listCancelled, listRecurring, markAlertsNotified, refreshAlerts, setRecurringStatus } from "@/operations/recurring";
import {
  createPerson,
  dismissPayment,
  forgive,
  listPeople,
  match,
  owedToMe,
  proposals,
  setShares,
  transactionReimbursements,
  unmatch,
  updatePerson,
} from "@/operations/reimbursements";
import { investmentIncome } from "@/operations/investments";
import { createCategory, deleteCategory, listCategories, moveCategory, renameCategory } from "@/operations/categories";
import { createRule, deleteRule, listRules, updateRule } from "@/operations/rules";
import { deleteTag, listTags, renameTag, setTransactionTags } from "@/operations/tags";
import type { Operation } from "@/operations/define";
import { taxAssumptions, payStubLines, payStubs, accounts, alerts, balanceSnapshots, goalAccounts, goals, budgetAdjustments, budgetTargets, categories, people, recurringSeries, reimbursementMatches, reimbursements, holdingSnapshots, categorySuggestions, rules, tags, transactionSplits, transactionTags, transactions } from "@/db/schema";
import {
  applyCategories,
  backfillMerchants,
  getTransaction,
  listInbox,
  recordSuggestions,
  listTransactions,
  matchTransfers,
  setExperienceDate,
  setTransactionCategory,
  spendingLines,
  splitTransaction,
  unmatchTransfer,
} from "@/operations/transactions";

// The one list of everything that can be done to the ledger. The UI calls
// these, Tally gets them as tools (#11), and the nightly pipeline runs them. Adding a capability means adding it
// here; nothing else needs a parallel definition.
export const operations: Operation[] = [
  listAccounts,
  updateAccount,
  createManualAccount,
  setManualValue,
  deleteManualAccount,
  listCategories,
  createCategory,
  renameCategory,
  moveCategory,
  deleteCategory,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listTransactions,
  getTransaction,
  spendingLines,
  investmentIncome,
  budgetStatus,
  listTargets,
  setTarget,
  removeTarget,
  rebalance,
  listGoals,
  createGoal,
  updateGoal,
  archiveGoal,
  listRecurring,
  listCancelled,
  cancelRecurring,
  setRecurringStatus,
  refreshAlerts,
  markAlertsNotified,
  listAlerts,
  dismissAlert,
  listPeople,
  createPerson,
  updatePerson,
  setShares,
  forgive,
  match,
  unmatch,
  dismissPayment,
  owedToMe,
  proposals,
  transactionReimbursements,
  listInbox,
  categoryChoices,
  setTransactionCategory,
  splitTransaction,
  setExperienceDate,
  matchTransfers,
  unmatchTransfer,
  listProvisional,
  matchProvisional,
  discardProvisional,
  createProvisional,
  listPayStubs,
  payDepositCandidates,
  createPayStub,
  updatePayStub,
  deletePayStub,
  linkPayDeposit,
  taxEstimate,
  setTaxAssumptions,
  listTags,
  setTransactionTags,
  renameTag,
  deleteTag,
  applyCategories,
  recordSuggestions,
  backfillMerchants,
  applySnapshot,
] as Operation[];

const byName = new Map(operations.map((op) => [op.name, op]));

export function getOperation(name: string): Operation | undefined {
  return byName.get(name);
}

/** Machine-readable catalog for tool-calling surfaces: name, description, kind, JSON Schema input. */
export function describeOperations() {
  return operations.map((op) => ({
    name: op.name,
    description: op.description,
    kind: op.kind,
    inputSchema: z.toJSONSchema(op.input, { io: "input" }),
  }));
}

// Tables tracked writes may touch, by SQL name — how undo finds the drizzle
// table for a logged change. A write to a table missing here can't be undone,
// and the undo test fails loudly if that happens.
export const trackedTables = {
  accounts,
  balance_snapshots: balanceSnapshots,
  budget_targets: budgetTargets,
  budget_adjustments: budgetAdjustments,
  people,
  reimbursements,
  recurring_series: recurringSeries,
  alerts,
  goals,
  goal_accounts: goalAccounts,
  reimbursement_matches: reimbursementMatches,
  holding_snapshots: holdingSnapshots,
  categories,
  rules,
  transactions,
  transaction_splits: transactionSplits,
  tags,
  transaction_tags: transactionTags,
  category_suggestions: categorySuggestions,
  pay_stubs: payStubs,
  pay_stub_lines: payStubLines,
  tax_assumptions: taxAssumptions,
} as const;
