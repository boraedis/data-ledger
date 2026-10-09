import { eq } from "drizzle-orm";
import { z } from "zod";
import { ACCOUNT_KINDS, accounts, countsTowardBudgetsByDefault } from "@/db/schema";
import type { Db } from "@/db/types";
import { defineRead, defineWrite } from "@/operations/define";

export const listAccounts = defineRead({
  name: "accounts.list",
  description:
    "List all accounts with institution, kind (checking, savings, credit, payment_app, brokerage, retirement, " +
    "loan, other_asset) and whether each counts toward budgets. `name` is the owner's name for the account if set.",
  input: z.object({}),
  run: async (db) => {
    const rows = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        displayName: accounts.displayName,
        institution: accounts.institution,
        kind: accounts.type,
        countsTowardBudgets: accounts.countsTowardBudgets,
      })
      .from(accounts);
    // Balances deliberately left out: this shape is what Tally sees, and
    // balances never go to a model (AGENTS.md).
    return rows
      .map(({ displayName, name, ...rest }) => ({ ...rest, name: displayName ?? name, bankName: name }))
      .sort((a, b) => a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name));
  },
});

export const updateAccount = defineWrite({
  name: "accounts.update",
  description:
    "Change an account's kind, display name, or whether it counts toward budgets. Changing the kind also resets " +
    "the budget flag to that kind's default unless countsTowardBudgets is given. displayName null restores the bank's name.",
  input: z.object({
    accountId: z.uuid(),
    kind: z.enum(ACCOUNT_KINDS).optional(),
    displayName: z.string().trim().min(1).max(60).nullable().optional(),
    countsTowardBudgets: z.boolean().optional(),
  }),
  apply: async (ctx, { accountId, kind, displayName, countsTowardBudgets }) => {
    const set: Partial<typeof accounts.$inferInsert> = {};
    if (kind !== undefined) {
      set.type = kind;
      // Reclassifying an account as brokerage should take it out of budgets
      // without a second step; an explicit flag in the same call wins.
      set.countsTowardBudgets = countsTowardBudgets ?? countsTowardBudgetsByDefault(kind);
    } else if (countsTowardBudgets !== undefined) {
      set.countsTowardBudgets = countsTowardBudgets;
    }
    if (displayName !== undefined) set.displayName = displayName;
    if (Object.keys(set).length === 0) throw new Error("Nothing to change");
    return ctx.update(accounts, accountId, set);
  },
});

/**
 * Account ids whose transactions count as spending and income. Every
 * spending query and budget (#7) filters through this — investment trades,
 * loan payments-as-principal and asset revaluations never read as spending.
 */
export function budgetAccountIds(db: Db) {
  return db.select({ id: accounts.id }).from(accounts).where(eq(accounts.countsTowardBudgets, true));
}
