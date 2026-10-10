import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ACCOUNT_KINDS, accounts, balanceSnapshots, countsTowardBudgetsByDefault, transactions } from "@/db/schema";
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
        source: accounts.source,
      })
      .from(accounts);
    // Balances deliberately left out: this shape is what Tally sees, and
    // balances never go to a model (AGENTS.md).
    return rows
      .map(({ displayName, name, source, ...rest }) => ({
        ...rest,
        name: displayName ?? name,
        bankName: name,
        // Kept up by hand, not by a bank: its value is only as fresh as the
        // owner's last update.
        manual: source === "manual",
      }))
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
    // A manual account has no transactions, and its revaluations are never
    // spending, so no kind change puts it into budgets.
    if (set.countsTowardBudgets) {
      const [row] = await ctx.db.select({ source: accounts.source }).from(accounts).where(eq(accounts.id, accountId));
      if (row?.source === "manual") set.countsTowardBudgets = false;
    }
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

// --- Manual accounts (#26) ---------------------------------------------------
//
// Accounts no aggregator covers: a home, a car, a private loan, an account at
// an unsupported institution. The owner enters a value now and then; each
// entry is a dated balance snapshot, so manual accounts feed net-worth history
// exactly like synced ones (src/lib/net-worth.ts). A liability's value is the
// amount owed, entered as a positive number; the net-worth sign convention
// counts loan and credit kinds as owed whatever the sign.
//
// Owner only. Tally could otherwise read a value back from its own tool call,
// and balances never go to a model (AGENTS.md); the owner can still ask Tally
// to remind them to update something.

// Manual values are in the one currency net worth sums.
const MANUAL_CURRENCY = "USD";

// A date's balance is "as of" midday UTC, so it shows as that date in any
// US time zone.
function asOf(on: string): Date {
  return new Date(`${on}T12:00:00Z`);
}

const manualValue = z.number().int().min(0).max(1_000_000_000_00);
const valueDate = z.iso.date().refine((on) => on <= new Date().toISOString().slice(0, 10), "Can't record a value in the future");

async function manualAccount(db: Db, accountId: string) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new Error("Account not found");
  if (account.source !== "manual") throw new Error("Only manual accounts take hand-entered values; this one comes from a bank sync");
  return account;
}

export const createManualAccount = defineWrite({
  name: "accounts.createManual",
  description:
    "Add an account the owner keeps up by hand (a home, a car, a private loan, an unsupported institution) with its " +
    "current value. For a loan or credit kind, the value is the amount owed.",
  allowedActors: ["user"],
  input: z.object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(ACCOUNT_KINDS),
    // Shown where an institution would be; optional, since a house has none.
    institution: z.string().trim().max(60).optional(),
    valueCents: manualValue,
    on: valueDate,
  }),
  apply: async (ctx, { name, kind, institution, valueCents, on }) => {
    const account = await ctx.insert(accounts, {
      name,
      institution: institution || "Manual",
      type: kind,
      source: "manual",
      currency: MANUAL_CURRENCY,
      // Nothing posts transactions to a manual account, and a revaluation
      // is never spending.
      countsTowardBudgets: false,
      balanceCents: valueCents,
      balanceAt: asOf(on),
    });
    await ctx.insert(balanceSnapshots, { accountId: account.id, on, balanceCents: valueCents, balanceAt: asOf(on) });
    return { id: account.id };
  },
});

export const setManualValue = defineWrite({
  name: "accounts.setManualValue",
  description:
    "Record a manual account's value on a date. A date in the past adds to its history; " +
    "the current value is the most recent one.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid(), valueCents: manualValue, on: valueDate }),
  apply: async (ctx, { accountId, valueCents, on }) => {
    await manualAccount(ctx.db, accountId);
    // One value per day, like synced balances: a second entry for the same
    // date corrects the first.
    const [sameDay] = await ctx.db
      .select()
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.accountId, accountId), eq(balanceSnapshots.on, on)));
    if (sameDay) await ctx.update(balanceSnapshots, sameDay.id, { balanceCents: valueCents, balanceAt: asOf(on) });
    else await ctx.insert(balanceSnapshots, { accountId, on, balanceCents: valueCents, balanceAt: asOf(on) });

    // The account's current value is its latest-dated entry, so back-filling
    // last spring's appraisal doesn't overwrite this month's.
    const [latest] = await ctx.db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, accountId))
      .orderBy(desc(balanceSnapshots.on))
      .limit(1);
    if (latest.on === on) await ctx.update(accounts, accountId, { balanceCents: valueCents, balanceAt: asOf(on) });
    return { accountId, on };
  },
});

export const deleteManualAccount = defineWrite({
  name: "accounts.deleteManual",
  description: "Remove a manual account and its value history. Synced accounts can't be removed this way.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid() }),
  apply: async (ctx, { accountId }) => {
    await manualAccount(ctx.db, accountId);
    const [{ value: txns }] = await ctx.db
      .select({ value: count() })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));
    if (txns > 0) throw new Error("This account has transactions; it can't be removed");
    // History first, through tracked removes: the FK cascade would delete it
    // invisibly, and undo couldn't bring it back.
    const history = await ctx.db.select({ id: balanceSnapshots.id }).from(balanceSnapshots).where(eq(balanceSnapshots.accountId, accountId));
    for (const { id } of history) await ctx.remove(balanceSnapshots, id);
    await ctx.remove(accounts, accountId);
    return { accountId, valuesRemoved: history.length };
  },
});
