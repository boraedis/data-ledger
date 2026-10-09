import { z } from "zod";
import { listAccounts } from "@/operations/accounts";
import { applySnapshot } from "@/operations/import";
import { createCategory, listCategories, renameCategory } from "@/operations/categories";
import type { Operation } from "@/operations/define";
import { accounts, categories, transactions } from "@/db/schema";
import { listTransactions, setTransactionCategory } from "@/operations/transactions";

// The one list of everything that can be done to the ledger. The UI calls
// these, Tally gets them as tools (#11), and the nightly pipeline runs them. Adding a capability means adding it
// here; nothing else needs a parallel definition.
export const operations: Operation[] = [
  listAccounts,
  listCategories,
  createCategory,
  renameCategory,
  listTransactions,
  setTransactionCategory,
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
export const trackedTables = { accounts, categories, transactions } as const;
