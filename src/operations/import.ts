import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  balanceSnapshots,
  countsTowardBudgetsByDefault,
  transactionSplits,
  transactionTags,
  transactions,
  type AccountKind,
} from "@/db/schema";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { defineWrite } from "@/operations/define";

// Applies one connector snapshot to the ledger. Runs only as actor
// "import", from the sync runner (src/lib/sync) — never by hand — so every
// sync is a single logged, undoable command: undoing it removes exactly
// what that sync added and restores what it changed.
//
// Idempotent by construction: rows are matched on the provider's IDs, and a
// row whose fields haven't changed isn't written at all. Re-running the same
// snapshot logs a command with no changes.

const rawAccount = z.object({
  externalId: z.string().min(1),
  name: z.string(),
  institution: z.string(),
  institutionId: z.string(),
  currency: z.string(),
  balanceCents: z.number().int(),
  availableBalanceCents: z.number().int().nullable(),
  balanceAt: z.iso.datetime({ offset: true }),
});

const rawTransaction = z.object({
  accountExternalId: z.string().min(1),
  externalId: z.string().min(1),
  postedOn: z.iso.date(),
  amountCents: z.number().int(),
  description: z.string(),
  payee: z.string().nullable(),
  memo: z.string().nullable(),
  pending: z.boolean(),
});

/**
 * Providers don't say what kind of account something is, so guess from the
 * name. Only used when an account is first seen; a later sync never
 * overwrites it, so a correction made by the owner sticks.
 *
 * The investment and loan patterns matter most: they decide whether a new
 * account counts toward budgets before the owner has looked at it, so they
 * err toward recognizing anything investment-like. Order matters — "Roth
 * IRA Brokerage" is retirement, "Mortgage Savings" is a loan.
 */
export function guessAccountType(name: string): AccountKind {
  const is = (pattern: RegExp) => pattern.test(name);
  if (is(/401\s?\(?k\)?|403\s?\(?b\)?|\b457\b|\bira\b|\broth\b|\bsep\b|retire|pension|\bhsa\b/i)) return "retirement";
  if (is(/mortgage|heloc|line of credit|\bloan\b/i)) return "loan";
  if (is(/venmo|paypal|cash ?app|zelle/i)) return "payment_app";
  // "Credit Union Checking" is a checking account, not a card.
  if (is(/\bcard\b|visa|mastercard|amex|american express|discover|credit(?! union)/i)) return "credit";
  // Explicit deposit words win over the broad brokerage words below, so
  // "Joint Checking" stays checking.
  if (is(/checking|share draft/i)) return "checking";
  if (is(/saving|money market|\bcd\b|certificate/i)) return "savings";
  if (is(/brokerage|invest|individual|joint|trading|securities|\bstocks?\b|portfolio|wealth|cash management/i)) return "brokerage";
  return "checking";
}

// How far apart a pending transaction and its posted version can be dated
// and still be treated as the same purchase.
const PENDING_MATCH_DAYS = 5;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

export const applySnapshot = defineWrite({
  name: "import.applySnapshot",
  description: "Apply a bank sync: upsert accounts, balances and transactions from a connector snapshot.",
  allowedActors: ["import"],
  input: z.object({
    connectionId: z.uuid(),
    // The start of the fetched window. Only pending transactions inside it
    // can be judged missing; older ones simply weren't asked for.
    windowStart: z.iso.date(),
    // The day the balances are recorded under (UTC), for net-worth history.
    // Passed in rather than read from the clock so the command log says
    // exactly what the operation did. Defaults to today.
    snapshotOn: z.iso.date().optional(),
    accounts: z.array(rawAccount),
    transactions: z.array(rawTransaction),
  }),
  apply: async (ctx, input) => {
    const counts = { accountsAdded: 0, inserted: 0, updated: 0, removed: 0, snapshots: 0 };
    const snapshotOn = input.snapshotOn ?? new Date().toISOString().slice(0, 10);

    // --- Accounts -----------------------------------------------------------
    const existingAccounts = await ctx.db.select().from(accounts).where(eq(accounts.connectionId, input.connectionId));
    const accountIdByExternal = new Map(existingAccounts.map((a) => [a.externalId!, a.id]));

    for (const raw of input.accounts) {
      const values = {
        name: raw.name,
        institution: raw.institution,
        institutionId: raw.institutionId,
        currency: raw.currency,
        balanceCents: raw.balanceCents,
        availableBalanceCents: raw.availableBalanceCents,
        balanceAt: new Date(raw.balanceAt),
      };
      const existing = existingAccounts.find((a) => a.externalId === raw.externalId);
      if (!existing) {
        const kind = guessAccountType(raw.name);
        const row = await ctx.insert(accounts, {
          ...values,
          externalId: raw.externalId,
          connectionId: input.connectionId,
          source: "simplefin",
          type: kind,
          countsTowardBudgets: countsTowardBudgetsByDefault(kind),
        });
        accountIdByExternal.set(raw.externalId, row.id);
        counts.accountsAdded++;
      } else if (
        existing.name !== values.name ||
        existing.institution !== values.institution ||
        existing.balanceCents !== values.balanceCents ||
        existing.availableBalanceCents !== values.availableBalanceCents ||
        existing.balanceAt?.getTime() !== values.balanceAt.getTime()
      ) {
        await ctx.update(accounts, existing.id, values);
      }
    }

    // --- Balance snapshots --------------------------------------------------
    // Every account in the snapshot gets today's balance recorded, changed
    // or not: an unchanged balance is still a data point, and a gap would
    // read as "unknown" rather than "flat". A later sync the same day
    // replaces the row. Inside this command, so undoing a sync takes its
    // snapshots with it.
    // Only accounts present in this snapshot: one the provider dropped
    // keeps its last balance rather than being judged unchanged.
    const snapshotAccountIds = input.accounts.map((a) => accountIdByExternal.get(a.externalId)!);
    const todays = snapshotAccountIds.length
      ? await ctx.db
          .select()
          .from(balanceSnapshots)
          .where(and(inArray(balanceSnapshots.accountId, snapshotAccountIds), eq(balanceSnapshots.on, snapshotOn)))
      : [];
    for (const raw of input.accounts) {
      const accountId = accountIdByExternal.get(raw.externalId)!;
      const balanceAt = new Date(raw.balanceAt);
      const existing = todays.find((row) => row.accountId === accountId);
      if (!existing) {
        await ctx.insert(balanceSnapshots, { accountId, on: snapshotOn, balanceCents: raw.balanceCents, balanceAt });
        counts.snapshots++;
      } else if (existing.balanceCents !== raw.balanceCents || existing.balanceAt?.getTime() !== balanceAt.getTime()) {
        await ctx.update(balanceSnapshots, existing.id, { balanceCents: raw.balanceCents, balanceAt });
        counts.snapshots++;
      }
    }

    // --- Transactions -------------------------------------------------------
    const accountIds = [...accountIdByExternal.values()];
    const snapshotIds = input.transactions.map((t) => t.externalId);
    const existingTxns = accountIds.length && snapshotIds.length
      ? await ctx.db
          .select()
          .from(transactions)
          .where(and(inArray(transactions.accountId, accountIds), inArray(transactions.externalId, snapshotIds)))
      : [];
    const existingByKey = new Map(existingTxns.map((t) => [`${t.accountId}|${t.externalId}`, t]));

    const insertedPosted: { id: string; accountId: string; amountCents: number; postedOn: string }[] = [];
    const seen = new Set<string>();

    for (const raw of input.transactions) {
      const accountId = accountIdByExternal.get(raw.accountExternalId);
      if (!accountId) continue; // a transaction for an account not in the snapshot; skip rather than guess
      const key = `${accountId}|${raw.externalId}`;
      seen.add(key);
      const values = {
        postedOn: raw.postedOn,
        amountCents: raw.amountCents,
        description: raw.description,
        payee: raw.payee,
        memo: raw.memo,
        pending: raw.pending,
        merchant: normalizeMerchant(raw.description, raw.payee),
      };
      const existing = existingByKey.get(key);
      if (!existing) {
        const row = await ctx.insert(transactions, { ...values, accountId, externalId: raw.externalId });
        counts.inserted++;
        if (!raw.pending) insertedPosted.push({ id: row.id, accountId, amountCents: raw.amountCents, postedOn: raw.postedOn });
      } else if (
        existing.postedOn !== values.postedOn ||
        existing.amountCents !== values.amountCents ||
        existing.description !== values.description ||
        existing.payee !== values.payee ||
        existing.memo !== values.memo ||
        existing.pending !== values.pending ||
        existing.merchant !== values.merchant
      ) {
        // Fields from the bank only; categoryId and anything else the owner
        // set is left alone.
        await ctx.update(transactions, existing.id, values);
        counts.updated++;
      }
    }

    // --- Pending → posted ---------------------------------------------------
    // Many banks give a transaction a new ID when it posts, so the pending
    // row just stops appearing. Any pending row inside this window that the
    // snapshot no longer has is gone; if a newly posted transaction looks
    // like it (same account and amount, within a few days), it inherits the
    // pending row's category, split, tags and experience date, so the owner
    // doesn't redo any of it.
    const pendingInWindow = snapshotAccountIds.length
      ? await ctx.db
          .select()
          .from(transactions)
          .where(
            and(
              inArray(transactions.accountId, snapshotAccountIds),
              eq(transactions.pending, true),
              gte(transactions.postedOn, input.windowStart),
            ),
          )
      : [];

    for (const stale of pendingInWindow) {
      if (seen.has(`${stale.accountId}|${stale.externalId}`)) continue;
      const [parts, links] = await Promise.all([
        ctx.db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, stale.id)).orderBy(transactionSplits.position),
        ctx.db.select().from(transactionTags).where(eq(transactionTags.transactionId, stale.id)),
      ]);
      const ownerWork = stale.categoryId || stale.isSplit || stale.experiencedOn || links.length;
      const match = ownerWork
        ? insertedPosted.find(
            (t) =>
              t.accountId === stale.accountId &&
              t.amountCents === stale.amountCents &&
              daysBetween(t.postedOn, stale.postedOn) <= PENDING_MATCH_DAYS,
          )
        : undefined;
      if (match) {
        // Everything the owner did to the pending row moves to its posted
        // version: category or split, experience date, and tags.
        await ctx.update(transactions, match.id, {
          categoryId: stale.categoryId,
          isSplit: stale.isSplit,
          experiencedOn: stale.experiencedOn,
        });
        for (const part of parts) {
          await ctx.insert(transactionSplits, {
            transactionId: match.id,
            amountCents: part.amountCents,
            categoryId: part.categoryId,
            note: part.note,
            position: part.position,
          });
        }
        for (const link of links) await ctx.insert(transactionTags, { transactionId: match.id, tagId: link.tagId });
        insertedPosted.splice(insertedPosted.indexOf(match), 1);
      }
      // Remove dependents through tracked writes before the row itself:
      // the FK cascade would delete them invisibly, and undoing this sync
      // couldn't bring them back.
      for (const part of parts) await ctx.remove(transactionSplits, part.id);
      for (const link of links) await ctx.remove(transactionTags, link.id);
      await ctx.remove(transactions, stale.id);
      counts.removed++;
    }

    return counts;
  },
});
