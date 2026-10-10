import { z } from "zod";
import { listAccounts, updateAccount } from "@/operations/accounts";
import { applySnapshot } from "@/operations/import";
import { createCategory, deleteCategory, listCategories, moveCategory, renameCategory } from "@/operations/categories";
import { createRule, deleteRule, listRules, updateRule } from "@/operations/rules";
import { deleteTag, listTags, renameTag, setTransactionTags } from "@/operations/tags";
import type { Operation } from "@/operations/define";
import { accounts, categories, categorySuggestions, rules, tags, transactionSplits, transactionTags, transactions } from "@/db/schema";
import {
  applyCategories,
  backfillMerchants,
  getTransaction,
  listInbox,
  recordSuggestions,
  listTransactions,
  setExperienceDate,
  setTransactionCategory,
  spendingLines,
  splitTransaction,
} from "@/operations/transactions";

// The one list of everything that can be done to the ledger. The UI calls
// these, Tally gets them as tools (#11), and the nightly pipeline runs them. Adding a capability means adding it
// here; nothing else needs a parallel definition.
export const operations: Operation[] = [
  listAccounts,
  updateAccount,
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
  listInbox,
  setTransactionCategory,
  splitTransaction,
  setExperienceDate,
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
  categories,
  rules,
  transactions,
  transaction_splits: transactionSplits,
  tags,
  transaction_tags: transactionTags,
  category_suggestions: categorySuggestions,
} as const;
