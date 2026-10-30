import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  alerts,
  categorySuggestions,
  provisionalSource,
  reimbursementMatches,
  reimbursements,
  transactionSplits,
  transactionTags,
  transactions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { DAYS_AFTER, DAYS_BEFORE, dayOffset, isStale } from "@/lib/provisional/match";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Provisional transactions (#30). A purchase alert (#31 email, #32 Apple
// Pay) creates one at once, so it can be notified, categorized and
// itemized on the spot. When the daily sync brings the bank's own version,
// the two are matched: everything the owner did carries over to the
// synced row and the provisional one is removed, as one undoable command,
// the same way a pending transaction hands over to its posted one
// (src/operations/import.ts). The sync stays the source of truth.

const today = () => new Date().toISOString().slice(0, 10);
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

export const createProvisional = defineWrite({
  name: "transactions.createProvisional",
  description:
    "Alerts only: record a purchase from a near-real-time alert as a provisional transaction, until the " +
    "bank reports it.",
  // Only the alert sources create these. The owner's and Tally's
  // transactions all come from the bank.
  allowedActors: ["alert"],
  input: z.object({
    accountId: z.uuid(),
    postedOn: z.iso.date(),
    // Signed like every transaction: a purchase is negative.
    amountCents: z.number().int().refine((n) => n !== 0, "A purchase has an amount"),
    // What the alert said, e.g. the merchant's name. Raw, like a bank
    // description; the merchant is derived from it.
    description: z.string().trim().min(1).max(200),
    source: z.enum(provisionalSource.enumValues),
    // The alert's own id (an email's Message-ID, a Shortcut run's id).
    // The same alert delivered twice is recorded once.
    ref: z.string().trim().min(1).max(300),
  }),
  apply: async (ctx, input) => {
    const [account] = await ctx.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId));
    if (!account) throw new NotFoundError("Account not found");
    const externalId = `${input.source}:${input.ref}`;

    const [again] = await ctx.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.accountId, input.accountId), eq(transactions.externalId, externalId)));
    if (again) return { status: "duplicate" as const, transactionId: again.id };

    // The bank got there first (a slow alert): the synced row is the
    // purchase, and there's nothing provisional to add. Only rows dated
    // from the purchase on: an earlier identical charge is another one.
    const [already] = await ctx.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, input.accountId),
          isNull(transactions.provisionalSource),
          eq(transactions.amountCents, input.amountCents),
          gte(transactions.postedOn, input.postedOn),
          lte(transactions.postedOn, shift(input.postedOn, DAYS_AFTER)),
        ),
      )
      .orderBy(asc(transactions.postedOn))
      .limit(1);
    if (already) return { status: "already_synced" as const, transactionId: already.id };

    const row = await ctx.insert(transactions, {
      accountId: input.accountId,
      postedOn: input.postedOn,
      amountCents: input.amountCents,
      description: input.description,
      merchant: normalizeMerchant(input.description, null),
      externalId,
      provisionalSource: input.source,
    });
    return { status: "created" as const, transactionId: row.id };
  },
});

/**
 * Moves everything attached to a provisional (#30) or manual (#64)
 * transaction onto the bank's version of it, then removes it. The synced row keeps whatever is already set
 * on it, and otherwise takes the provisional row's category or split,
 * experience date and tags. Shares friends owe, matched payments and
 * alerts follow it too. A split carries over only when the amounts agree,
 * since its parts must add up to the transaction.
 */
export async function handOver(ctx: WriteContext, fromId: string, toId: string) {
  const [[from], [to]] = await Promise.all([
    ctx.db.select().from(transactions).where(eq(transactions.id, fromId)),
    ctx.db.select().from(transactions).where(eq(transactions.id, toId)),
  ]);
  if (!from || !to) throw new NotFoundError("Transaction not found");
  if (!from.provisionalSource && from.source !== "manual") throw new Error("Only a provisional or manual transaction can be matched to the bank's version");
  if (to.provisionalSource || to.source === "manual") throw new Error("Match it to a transaction the bank reported");
  if (to.pending) throw new Error("Wait until it posts: a pending transaction can be replaced when it does");
  if (from.accountId !== to.accountId) throw new Error("Both must be in the same account");

  const [parts, links, toLinks, shares, paid, flagged, suggestion] = await Promise.all([
    ctx.db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, fromId)).orderBy(transactionSplits.position),
    ctx.db.select().from(transactionTags).where(eq(transactionTags.transactionId, fromId)),
    ctx.db.select().from(transactionTags).where(eq(transactionTags.transactionId, toId)),
    ctx.db.select({ id: reimbursements.id }).from(reimbursements).where(eq(reimbursements.transactionId, fromId)),
    ctx.db.select({ id: reimbursementMatches.id }).from(reimbursementMatches).where(eq(reimbursementMatches.transactionId, fromId)),
    ctx.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.transactionId, fromId)),
    ctx.db.select({ id: categorySuggestions.id }).from(categorySuggestions).where(eq(categorySuggestions.transactionId, fromId)),
  ]);

  const toFiled = to.categoryId !== null || to.isSplit;
  const carried: Partial<typeof transactions.$inferInsert> = {};
  if (!toFiled && from.isSplit && from.amountCents === to.amountCents) {
    carried.isSplit = true;
    for (const part of parts) {
      await ctx.insert(transactionSplits, { transactionId: toId, amountCents: part.amountCents, categoryId: part.categoryId, note: part.note, position: part.position });
    }
  } else if (!toFiled && from.categoryId) {
    carried.categoryId = from.categoryId;
  }
  if (!to.experiencedOn && from.experiencedOn) carried.experiencedOn = from.experiencedOn;
  if (Object.keys(carried).length) await ctx.update(transactions, toId, carried);

  const hasTag = new Set(toLinks.map((l) => l.tagId));
  for (const link of links) if (!hasTag.has(link.tagId)) await ctx.insert(transactionTags, { transactionId: toId, tagId: link.tagId });
  for (const share of shares) await ctx.update(reimbursements, share.id, { transactionId: toId });
  for (const m of paid) await ctx.update(reimbursementMatches, m.id, { transactionId: toId });
  for (const a of flagged) await ctx.update(alerts, a.id, { transactionId: toId });

  // Dependents go through tracked writes before the row itself: the FK
  // cascade would delete them invisibly, and undo couldn't restore them.
  for (const part of parts) await ctx.remove(transactionSplits, part.id);
  for (const link of links) await ctx.remove(transactionTags, link.id);
  for (const s of suggestion) await ctx.remove(categorySuggestions, s.id);
  await ctx.remove(transactions, fromId);
  return { carriedCategory: Boolean(carried.categoryId || carried.isSplit) };
}

export const matchProvisional = defineWrite({
  name: "transactions.matchProvisional",
  description:
    "Match provisional transactions (from purchase alerts) to the transactions the bank reported for them: " +
    "the category or split, experience date, tags and shared-expense details carry over, and the provisional " +
    "one is removed. Both must be in the same account; the amounts may differ (a tip added later).",
  input: z.object({
    pairs: z.array(z.object({ provisionalId: z.uuid(), transactionId: z.uuid() })).min(1).max(500),
  }),
  apply: async (ctx, { pairs }) => {
    const used = new Set<string>();
    for (const { provisionalId, transactionId } of pairs) {
      if (used.has(provisionalId) || used.has(transactionId)) throw new Error("Each transaction can be in only one match");
      used.add(provisionalId).add(transactionId);
    }
    let matched = 0;
    let carried = 0;
    for (const { provisionalId, transactionId } of pairs) {
      const result = await handOver(ctx, provisionalId, transactionId);
      matched++;
      if (result.carriedCategory) carried++;
    }
    return { matched, carried };
  },
});

export const discardProvisional = defineWrite({
  name: "transactions.discardProvisional",
  description:
    "Remove a provisional transaction (from a purchase alert) that the bank never reported: a declined or " +
    "reversed charge, or an alert read wrong. Only provisional transactions can be removed.",
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const [row] = await ctx.db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!row) throw new NotFoundError("Transaction not found");
    if (!row.provisionalSource) throw new Error("Only a provisional transaction can be discarded; the bank's own transactions stay");
    const [shares, paid, parts, links, suggestion, flagged] = await Promise.all([
      ctx.db.select({ id: reimbursements.id }).from(reimbursements).where(eq(reimbursements.transactionId, transactionId)),
      ctx.db.select({ id: reimbursementMatches.id }).from(reimbursementMatches).where(eq(reimbursementMatches.transactionId, transactionId)),
      ctx.db.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)),
      ctx.db.select({ id: transactionTags.id }).from(transactionTags).where(eq(transactionTags.transactionId, transactionId)),
      ctx.db.select({ id: categorySuggestions.id }).from(categorySuggestions).where(eq(categorySuggestions.transactionId, transactionId)),
      ctx.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.transactionId, transactionId)),
    ]);
    // Friends' shares may already be paid against; unwinding that is a
    // decision for the owner, not a side effect of discarding.
    if (shares.length || paid.length) throw new Error("It's shared with friends: remove the shares first");
    for (const part of parts) await ctx.remove(transactionSplits, part.id);
    for (const link of links) await ctx.remove(transactionTags, link.id);
    for (const s of suggestion) await ctx.remove(categorySuggestions, s.id);
    for (const a of flagged) await ctx.update(alerts, a.id, { transactionId: null });
    await ctx.remove(transactions, transactionId);
    return { discarded: 1 };
  },
});

// How far after the purchase a hand-picked match may be. Wider than the
// automatic window: a restaurant tip or a hotel hold can take a while.
const CANDIDATE_DAYS_AFTER = 10;

export async function provisionalRows(db: Db, on: string) {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})`,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: transactions.description,
      merchant: transactions.merchant,
      source: transactions.provisionalSource,
      categoryId: transactions.categoryId,
      isSplit: transactions.isSplit,
      // The same rule as countsAsSpending(): has the bank's data for this
      // account reached the purchase's date?
      superseded: sql<boolean>`exists (
        select 1 from ${transactions} as synced
        where synced.account_id = ${transactions.accountId}
          and synced.provisional_source is null
          and synced.posted_on >= ${transactions.postedOn}
      )`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(isNotNull(transactions.provisionalSource))
    .orderBy(asc(transactions.postedOn), asc(transactions.createdAt));
  return rows.map(({ superseded, source, ...r }) => ({
    ...r,
    source: source!,
    counting: !superseded,
    stale: isStale(r.postedOn, on),
  }));
}

export const listProvisional = defineRead({
  name: "transactions.provisional",
  description:
    "Provisional transactions: purchases from near-real-time alerts that the bank hasn't reported yet, oldest " +
    "first. `counting` is whether it still counts as spending (it stops once the bank's data for its account " +
    "reaches its date). `stale` means a week has passed without a match: it may have been declined, or the " +
    "bank reported a different amount. Each has `candidates`: bank transactions in the same account soon " +
    "after, same merchant then closest amount first, to match by hand.",
  input: z.object({ on: z.iso.date().optional() }),
  run: async (db, { on = today() }) => {
    const rows = await provisionalRows(db, on);
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.accountId))];
    const earliest = shift(rows[0].postedOn, -DAYS_BEFORE);
    const synced = await db
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
          inArray(transactions.accountId, accountIds),
          isNull(transactions.provisionalSource),
          eq(transactions.pending, false),
          gte(transactions.postedOn, earliest),
        ),
      );
    return rows.map((r) => ({
      ...r,
      candidates: synced
        .filter((s) => s.accountId === r.accountId && s.amountCents * r.amountCents > 0)
        .filter((s) => {
          const offset = dayOffset(r.postedOn, s.postedOn);
          return offset >= -DAYS_BEFORE && offset <= CANDIDATE_DAYS_AFTER;
        })
        // The same merchant first when the alert's wording normalizes to
        // the bank's (often, not always), then the closest amount.
        .sort(
          (a, b) =>
            Number(b.merchant === r.merchant) - Number(a.merchant === r.merchant) ||
            Math.abs(a.amountCents - r.amountCents) - Math.abs(b.amountCents - r.amountCents) ||
            a.postedOn.localeCompare(b.postedOn),
        )
        .slice(0, 3)
        .map((s) => ({ id: s.id, postedOn: s.postedOn, amountCents: s.amountCents, description: s.description, merchant: s.merchant })),
    }));
  },
});
