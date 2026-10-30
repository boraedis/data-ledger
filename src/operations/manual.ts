import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, alerts, categories, categorySuggestions, reimbursementMatches, reimbursements, transactionSplits, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { DAYS_AFTER, DAYS_BEFORE, candidates } from "@/lib/manual/match";
import { defineRead, defineWrite } from "@/operations/define";
import { handOver } from "@/operations/provisional";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Transactions the owner adds by hand (#64): a payment-app payment, cash,
// anything the feed misses. Once added, one is like any other (categorize,
// split, tag, share, match to a reimbursement), marked source "manual".
// If the bank later reports the same purchase, the owner is asked to merge
// them (src/lib/manual/match.ts); until then only the bank's counts
// (countsAsSpending), so nothing is counted twice and nothing merges on
// its own.
//
// Into a synced account only. Manual accounts (#26) are balance-only: their
// value is what the owner enters, and transactions there would be a second
// truth that never adds up to it. Not investment accounts either: their
// activity comes from the brokerage, and holdings follow from it.

const today = () => new Date().toISOString().slice(0, 10);
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

const postedOn = z.iso.date().refine((on) => on <= today(), "Can't add a transaction in the future");
// Signed like every transaction: money out is negative. Exact cents.
const amountCents = z
  .number()
  .int()
  .refine((n) => n !== 0, "A transaction has an amount")
  .refine((n) => Math.abs(n) <= 100_000_000_00, "That amount is too large");
const description = z.string().trim().min(1).max(200);

async function assertTakesManual(db: Db, accountId: string) {
  const [account] = await db.select({ type: accounts.type, source: accounts.source }).from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new NotFoundError("Account not found");
  if (account.source === "manual") throw new Error("Manual accounts keep a balance only; add it to the account the money moved through");
  if (INVESTMENT_KINDS.includes(account.type)) throw new Error("Investment accounts take their activity from the brokerage");
}

async function manualRow(ctx: WriteContext, transactionId: string) {
  const [row] = await ctx.db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!row) throw new NotFoundError("Transaction not found");
  if (row.source !== "manual") throw new Error("Only a transaction added by hand can be changed or deleted; the bank's stay as reported");
  return row;
}

export const createManual = defineWrite({
  name: "transactions.createManual",
  description:
    "Add a transaction by hand, for money the bank feed doesn't show (a payment-app payment, cash). Signed cents: " +
    "money out is negative. Optionally with a category; otherwise it waits in the inbox like any other.",
  allowedActors: ["user", "tally"],
  input: z.object({ accountId: z.uuid(), postedOn, amountCents, description, categoryId: z.uuid().optional() }),
  apply: async (ctx, input) => {
    await assertTakesManual(ctx.db, input.accountId);
    if (input.categoryId) {
      const [category] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId));
      if (!category) throw new NotFoundError("Category not found");
    }
    const row = await ctx.insert(transactions, {
      accountId: input.accountId,
      postedOn: input.postedOn,
      amountCents: input.amountCents,
      description: input.description,
      merchant: normalizeMerchant(input.description, null),
      categoryId: input.categoryId ?? null,
      source: "manual",
    });
    return { transactionId: row.id };
  },
});

export const updateManual = defineWrite({
  name: "transactions.updateManual",
  description: "Change the date, amount or description of a transaction added by hand. The bank's transactions can't be changed.",
  allowedActors: ["user", "tally"],
  input: z.object({ transactionId: z.uuid(), postedOn: postedOn.optional(), amountCents: amountCents.optional(), description: description.optional() }),
  apply: async (ctx, { transactionId, ...change }) => {
    const row = await manualRow(ctx, transactionId);
    if (change.amountCents !== undefined && change.amountCents !== row.amountCents) {
      // Both must keep adding up to the transaction.
      if (row.isSplit) throw new Error("It's split: remove the split before changing the amount");
      const [shared] = await ctx.db.select({ id: reimbursements.id }).from(reimbursements).where(eq(reimbursements.transactionId, transactionId)).limit(1);
      if (shared) throw new Error("It's shared with friends: remove the shares before changing the amount");
    }
    const values: Partial<typeof transactions.$inferInsert> = {};
    if (change.postedOn !== undefined && change.postedOn !== row.postedOn) values.postedOn = change.postedOn;
    if (change.amountCents !== undefined && change.amountCents !== row.amountCents) values.amountCents = change.amountCents;
    if (change.description !== undefined && change.description !== row.description) {
      values.description = change.description;
      values.merchant = normalizeMerchant(change.description, null);
    }
    if (Object.keys(values).length) await ctx.update(transactions, transactionId, values);
    return { changed: Object.keys(values) };
  },
});

export const deleteManual = defineWrite({
  name: "transactions.deleteManual",
  description: "Delete a transaction added by hand. The bank's transactions can't be deleted.",
  allowedActors: ["user", "tally"],
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const row = await manualRow(ctx, transactionId);
    const [shares, paid, parts, links, suggestion, flagged] = await Promise.all([
      ctx.db.select({ id: reimbursements.id }).from(reimbursements).where(eq(reimbursements.transactionId, transactionId)),
      ctx.db.select({ id: reimbursementMatches.id }).from(reimbursementMatches).where(eq(reimbursementMatches.transactionId, transactionId)),
      ctx.db.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)),
      ctx.db.select({ id: transactionTags.id }).from(transactionTags).where(eq(transactionTags.transactionId, transactionId)),
      ctx.db.select({ id: categorySuggestions.id }).from(categorySuggestions).where(eq(categorySuggestions.transactionId, transactionId)),
      ctx.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.transactionId, transactionId)),
    ]);
    // Friends' shares may already be paid against; unwinding that is the
    // owner's decision, as for a provisional transaction.
    if (shares.length || paid.length) throw new Error("It's shared with friends: remove the shares first");
    if (row.transferPairId) throw new Error("It's one side of a transfer: mark it not a transfer first");
    // Dependents as tracked writes before the row: the FK cascade would
    // remove them where undo can't see.
    for (const part of parts) await ctx.remove(transactionSplits, part.id);
    for (const link of links) await ctx.remove(transactionTags, link.id);
    for (const s of suggestion) await ctx.remove(categorySuggestions, s.id);
    for (const a of flagged) await ctx.update(alerts, a.id, { transactionId: null });
    await ctx.remove(transactions, transactionId);
    return { deleted: 1 };
  },
});

export const manualMatches = defineRead({
  name: "transactions.manualMatches",
  description:
    "Transactions added by hand that the bank now seems to have reported too: the same account and amount, close in " +
    "date. Each has up to three `candidates`, likeliest first. Until the owner merges them or keeps both, only the " +
    "bank's counts. transactionId limits it to one manual transaction.",
  input: z.object({ transactionId: z.uuid().optional() }),
  run: async (db, { transactionId }) => {
    const manual = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})`,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(eq(transactions.source, "manual"), eq(transactions.notDuplicate, false), transactionId ? eq(transactions.id, transactionId) : undefined));
    if (manual.length === 0) return [];
    const dates = manual.map((m) => m.postedOn).sort();
    const bank = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        merchant: transactions.merchant,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.accountId, [...new Set(manual.map((m) => m.accountId))]),
          or(isNull(transactions.source), ne(transactions.source, "manual")),
          isNull(transactions.provisionalSource),
          eq(transactions.pending, false),
          gte(transactions.postedOn, shift(dates[0], -DAYS_BEFORE)),
          lte(transactions.postedOn, shift(dates.at(-1)!, DAYS_AFTER)),
        ),
      );
    return manual
      .map((m) => ({ ...m, candidates: candidates(m, bank).slice(0, 3) }))
      .filter((m) => m.candidates.length > 0)
      .sort((a, b) => b.postedOn.localeCompare(a.postedOn));
  },
});

export const mergeManual = defineWrite({
  name: "transactions.mergeManual",
  description:
    "Merge a transaction added by hand into the bank's version of the same purchase: its category or split, " +
    "experience date, tags and shares with friends carry over (the bank's own category, if set, stays) and the " +
    "manual one is removed. Same account and amount only.",
  allowedActors: ["user", "tally"],
  input: z.object({ manualId: z.uuid(), transactionId: z.uuid() }),
  apply: async (ctx, { manualId, transactionId }) => {
    const row = await manualRow(ctx, manualId);
    const [bank] = await ctx.db.select({ amountCents: transactions.amountCents }).from(transactions).where(eq(transactions.id, transactionId));
    if (!bank) throw new NotFoundError("Transaction not found");
    // A different amount is a different purchase, or a correction to make
    // first; merging would silently change what the owner typed.
    if (bank.amountCents !== row.amountCents) throw new Error("The amounts differ: they aren't the same purchase");
    if (row.transferPairId) throw new Error("It's one side of a transfer: mark it not a transfer first");
    await handOver(ctx, manualId, transactionId);
    return { merged: 1 };
  },
});

export const keepManual = defineWrite({
  name: "transactions.keepManual",
  description:
    "The owner says a transaction added by hand isn't the bank transaction that looks like it: both stay and both " +
    "count, and it isn't offered for merging again.",
  allowedActors: ["user", "tally"],
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    await manualRow(ctx, transactionId);
    await ctx.update(transactions, transactionId, { notDuplicate: true });
    return { kept: 1 };
  },
});
