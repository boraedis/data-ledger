import { z } from "zod";
import { createManualAccount, deleteManualAccount, listAccounts, setManualValue, updateAccount } from "@/operations/accounts";
import { budgetHistory, budgetMonthly, budgetStatus, listTargets, yearlyCharges, rebalance, removeTarget, setTarget } from "@/operations/budgets";
import { archiveGoal, createGoal, listGoals, updateGoal } from "@/operations/goals";
import { applySnapshot } from "@/operations/import";
import { createPayStub, deletePayStub, linkPayDeposit, listPayStubs, payDepositCandidates, updatePayStub } from "@/operations/pay";
import { categoryChoices } from "@/operations/choices";
import { setTaxAssumptions, taxEstimate } from "@/operations/taxes";
import { createProvisional, discardProvisional, listProvisional, matchProvisional } from "@/operations/provisional";
import { getImportMapping, importHistory, saveImportMapping } from "@/operations/history";
import { createManual, deleteManual, keepManual, manualMatches, mergeManual, updateManual } from "@/operations/manual";
import { cancelRecurring, dismissAlert, markStillActive, listAlerts, listCancelled, listRecurring, markAlertsNotified, refreshAlerts, setRecurringStatus } from "@/operations/recurring";
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
import { taxAssumptions, importMappings, payStubDeposits, payStubEmployerLines, payStubLines, payStubs, accounts, alerts, balanceSnapshots, goalAccounts, goals, budgetAdjustments, budgetTargets, categories, people, recurringSeries, reimbursementMatches, reimbursements, holdingSnapshots, categorySuggestions, rules, tags, transactionSplits, transactionTags, transactions } from "@/db/schema";
import {
  applyCategories,
  backfillMerchants,
  getTransaction,
  listInbox,
  recordSuggestions,
  listTransactions,
  matchTransfers,
  misfiledTransfers,
  pairAsTransfer,
  dismissTransfer,
  setExperienceDate,
  setCategories,
  setTransactionCategory,
  spendingLines,
  splitTransaction,
  uncategorizedSpend,
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
  uncategorizedSpend,
  investmentIncome,
  budgetStatus,
  budgetHistory,
  budgetMonthly,
  yearlyCharges,
  listTargets,
  setTarget,
  removeTarget,
  rebalance,
  listGoals,
  createGoal,
  updateGoal,
  archiveGoal,
  getImportMapping,
  saveImportMapping,
  importHistory,
  createManual,
  updateManual,
  deleteManual,
  manualMatches,
  mergeManual,
  keepManual,
  listRecurring,
  listCancelled,
  cancelRecurring,
  markStillActive,
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
  setCategories,
  splitTransaction,
  setExperienceDate,
  matchTransfers,
  unmatchTransfer,
  misfiledTransfers,
  pairAsTransfer,
  dismissTransfer,
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
  pay_stub_deposits: payStubDeposits,
  pay_stub_employer_lines: payStubEmployerLines,
  import_mappings: importMappings,
  tax_assumptions: taxAssumptions,
} as const;
