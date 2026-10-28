import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, alerts, categories, recurringSeries, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { formatCents } from "@/lib/money";
import { alertsFor, cancelGraceDays, chargesAfterCancel, detectSeries, seriesKey, type AlertDraft, type Series, type SeriesStatus } from "@/lib/recurring/detect";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Recurring charges and alerts (#9). Detection is computed on read from
// recent spending (src/lib/recurring/detect.ts); the owner's confirm,
// dismiss and cancel decisions and the raised alerts are the stored state. alerts.refresh runs
// nightly after the sync, and the digest (Home, later push — #29) reads
// alerts.list. Transaction-derived only, so Tally may read all of it.

const today = () => new Date().toISOString().slice(0, 10);
// A little over a year: enough for annual charges to show up twice.
const LOOKBACK_DAYS = 400;

/** Recent spending that could recur: posted, in budget accounts, not transfers. */
async function loadCharges(db: Db, on: string) {
  const since = new Date(Date.parse(on) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const transferCategories = db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer"));
  const rows = await db
    .select({ id: transactions.id, accountId: transactions.accountId, merchant: transactions.merchant, date: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedOn, since),
        sql`${transactions.postedOn} <= ${on}`,
        eq(transactions.pending, false),
        // An alert's provisional copy would look like a duplicate charge;
        // the synced version is the one that recurs.
        isNull(transactions.provisionalSource),
        sql`${transactions.amountCents} < 0`,
        isNull(transactions.transferPairId),
        inArray(transactions.accountId, budgetAccountIds(db)),
        // Card payments and the like, once filed as transfers, aren't bills.
        sql`(${transactions.categoryId} is null or ${notInArray(transactions.categoryId, transferCategories)})`,
      ),
    );
  return rows.filter((r) => r.merchant).map((r) => ({ ...r, merchant: r.merchant!, amountCents: -r.amountCents }));
}

async function decisions(db: Db) {
  const rows = await db.select().from(recurringSeries);
  return new Map(rows.map((r) => [seriesKey(r.merchant, r.accountId), r.status]));
}

/** Per series, the last charge as of the owner saying an ended bill is still active. */
async function stillActive(db: Db) {
  const rows = await db.select().from(recurringSeries);
  return new Map(rows.filter((r) => r.stillActiveAfter).map((r) => [seriesKey(r.merchant, r.accountId), r.stillActiveAfter!]));
}

/** Clears a series' open "stopped charging" alert once the owner has answered it. */
async function settleEndedAlerts(ctx: WriteContext, merchant: string, accountId: string) {
  const open = await ctx.db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.kind, "missing_charge"), eq(alerts.merchant, merchant), eq(alerts.accountId, accountId), isNull(alerts.dismissedAt)));
  for (const row of open) await ctx.update(alerts, row.id, { dismissedAt: new Date() });
}

async function cancellations(db: Db) {
  const rows = await db.select().from(recurringSeries).where(eq(recurringSeries.status, "cancelled"));
  return rows.map((r) => ({ merchant: r.merchant, accountId: r.accountId, cancelledOn: r.cancelledOn!, graceDays: r.cancelGraceDays ?? 7 }));
}

async function accountNames(db: Db) {
  const rows = await db.select({ id: accounts.id, name: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})` }).from(accounts);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function describe(series: Series, status: SeriesStatus | undefined, accountName: string, stillActiveAfter: string | undefined) {
  return {
    merchant: series.merchant,
    accountId: series.accountId,
    accountName,
    status: status ?? ("suggested" as const),
    cadence: series.cadence.name,
    typicalCents: series.typicalCents,
    latestCents: series.latestCents,
    variable: series.variable,
    charges: series.occurrences.length,
    firstOn: series.firstOn,
    lastOn: series.lastOn,
    nextExpectedOn: series.nextExpectedOn,
    annualizedCents: series.annualizedCents,
    active: series.active,
    overdue: series.overdue,
    // A tracked bill that went quiet and hasn't been answered: under Ended.
    // "Still active" answers it until a new charge comes.
    ended: status === "confirmed" && series.overdue && stillActiveAfter !== series.lastOn,
  };
}

export const listRecurring = defineRead({
  name: "recurring.list",
  description:
    "Recurring charges detected from merchant, cadence and amount (one merchant in one account), with status " +
    "(suggested, confirmed by the owner as a subscription/bill, dismissed as not one, or cancelled by the owner), cadence, usual and latest amount " +
    "in cents, next expected charge, and annualized cost. `active` is false when charges have stopped; `ended` " +
    "marks a tracked bill that went quiet and that the owner hasn't yet marked cancelled or still active.",
  input: z.object({ on: z.iso.date().optional() }),
  run: async (db, { on = today() }) => {
    const [charges, status, acked, names] = await Promise.all([loadCharges(db, on), decisions(db), stillActive(db), accountNames(db)]);
    return detectSeries(charges, on).map((s) => describe(s, status.get(s.key), names.get(s.accountId) ?? "", acked.get(s.key)));
  },
});

export const setRecurringStatus = defineWrite({
  name: "recurring.setStatus",
  description:
    "Confirm a detected recurring charge as a subscription or bill to track (alerts include a missing charge), " +
    "dismiss it (no list entry, no alerts), or clear the decision (status null).",
  input: z.object({ merchant: z.string().min(1), accountId: z.uuid(), status: z.enum(["confirmed", "dismissed"]).nullable() }),
  apply: async (ctx, { merchant, accountId, status }) => {
    const [existing] = await ctx.db
      .select()
      .from(recurringSeries)
      .where(and(eq(recurringSeries.merchant, merchant), eq(recurringSeries.accountId, accountId)));
    if (status === null) {
      if (existing) await ctx.remove(recurringSeries, existing.id);
      return { status: "suggested" };
    }
    // A new decision starts clean: no cancellation snapshot, no "still
    // active" from an earlier quiet spell.
    if (existing) await ctx.update(recurringSeries, existing.id, { status, cancelledOn: null, cancelledAnnualCents: null, cancelGraceDays: null, stillActiveAfter: null });
    else await ctx.insert(recurringSeries, { merchant, accountId, status });
    return { status };
  },
});

export const cancelRecurring = defineWrite({
  name: "recurring.cancel",
  description:
    "Mark a recurring charge as cancelled by the owner, as of a date (default today). It leaves the tracked list, " +
    "its yearly cost counts as saved, and any charge from that merchant and account after the date (and a short " +
    "grace window for a final bill) raises a \"charged after you cancelled\" alert.",
  input: z.object({ merchant: z.string().min(1), accountId: z.uuid(), cancelledOn: z.iso.date().optional() }),
  apply: async (ctx, { merchant, accountId, cancelledOn = today() }) => {
    // The cost and grace window are what it was as of the cancel date, kept.
    const series = detectSeries(await loadCharges(ctx.db, cancelledOn), cancelledOn).find((s) => s.key === seriesKey(merchant, accountId));
    if (!series) throw new NotFoundError(`No recurring charge from ${merchant} in that account`);
    const values = { status: "cancelled" as const, cancelledOn, cancelledAnnualCents: series.annualizedCents, cancelGraceDays: cancelGraceDays(series), stillActiveAfter: null };
    const [existing] = await ctx.db
      .select()
      .from(recurringSeries)
      .where(and(eq(recurringSeries.merchant, merchant), eq(recurringSeries.accountId, accountId)));
    if (existing) await ctx.update(recurringSeries, existing.id, values);
    else await ctx.insert(recurringSeries, { merchant, accountId, ...values });
    // Cancelling answers a "stopped charging" alert.
    await settleEndedAlerts(ctx, merchant, accountId);
    return { status: "cancelled", cancelledOn, annualizedCents: series.annualizedCents };
  },
});

export const markStillActive = defineWrite({
  name: "recurring.stillActive",
  description:
    "For a tracked bill that stopped charging: the owner says it's still active (a card problem, say), so keep " +
    "tracking it and stop alerting about this quiet spell. A new charge later ends the acknowledgement.",
  input: z.object({ merchant: z.string().min(1), accountId: z.uuid(), on: z.iso.date().optional() }),
  apply: async (ctx, { merchant, accountId, on = today() }) => {
    const series = detectSeries(await loadCharges(ctx.db, on), on).find((s) => s.key === seriesKey(merchant, accountId));
    if (!series) throw new NotFoundError(`No recurring charge from ${merchant} in that account`);
    const values = { status: "confirmed" as const, stillActiveAfter: series.lastOn, cancelledOn: null, cancelledAnnualCents: null, cancelGraceDays: null };
    const [existing] = await ctx.db
      .select()
      .from(recurringSeries)
      .where(and(eq(recurringSeries.merchant, merchant), eq(recurringSeries.accountId, accountId)));
    if (existing) await ctx.update(recurringSeries, existing.id, values);
    else await ctx.insert(recurringSeries, { merchant, accountId, ...values });
    await settleEndedAlerts(ctx, merchant, accountId);
    return { status: "confirmed", stillActiveAfter: series.lastOn };
  },
});

export const listCancelled = defineRead({
  name: "recurring.cancelled",
  description: "Recurring charges the owner cancelled: merchant, account, the cancel date, and the yearly cost at the time (what's saved).",
  input: z.object({}),
  run: async (db) => {
    const [rows, names] = await Promise.all([
      db.select().from(recurringSeries).where(eq(recurringSeries.status, "cancelled")).orderBy(desc(recurringSeries.cancelledOn)),
      accountNames(db),
    ]);
    return rows.map((r) => ({
      merchant: r.merchant,
      accountId: r.accountId,
      accountName: names.get(r.accountId) ?? "",
      cancelledOn: r.cancelledOn!,
      annualizedCents: r.cancelledAnnualCents ?? 0,
    }));
  },
});

// --- Alerts ---------------------------------------------------------------------

function message(draft: AlertDraft, accountName: string): { title: string; detail: string } {
  const m = draft.merchant;
  const where = accountName ? ` on ${accountName}` : "";
  switch (draft.kind) {
    case "price_increase":
      return {
        title: `${m} went up to ${formatCents(draft.toCents!)}`,
        detail: `Was ${formatCents(draft.fromCents!)}; charged ${formatCents(draft.toCents!)} on ${draft.occurredOn}${where}.`,
      };
    case "duplicate_charge":
      return { title: `${m} charged twice`, detail: `A second ${formatCents(draft.toCents!)} charge on ${draft.occurredOn}${where}, days after the first.` };
    case "overlapping_subscriptions":
      return { title: `Paying for ${m} twice`, detail: `${m} bills in more than one account, about ${formatCents(draft.toCents!)} a year in all.` };
    case "trial_converted":
      return {
        title: `${m} trial is now paid`,
        detail: `After a ${formatCents(draft.fromCents!)} trial, the first ${formatCents(draft.toCents!)} charge (${draft.cadence}) came on ${draft.occurredOn}${where}.`,
      };
    case "missing_charge":
      return {
        title: `${m} stopped charging`,
        detail:
          `Last charged ${formatCents(draft.fromCents!)} on ${draft.lastOn}${where}; the next was due around ${draft.occurredOn}. ` +
          `Cancelled, or a card problem? Answer it under Ended on Subscriptions.`,
      };
    case "charged_after_cancel":
      return {
        title: `${m} charged after you cancelled`,
        detail: `${formatCents(draft.toCents!)} on ${draft.occurredOn}${where}; you cancelled on ${draft.cancelledOn}.`,
      };
  }
}

export const refreshAlerts = defineWrite({
  name: "alerts.refresh",
  description: "Pipeline only: raise new alerts from recurring-charge detection. Each event is raised once.",
  allowedActors: ["matcher", "user"],
  input: z.object({ on: z.iso.date().optional() }),
  apply: async (ctx, { on = today() }) => {
    const [charges, status, cancelled, acked, names] = await Promise.all([
      loadCharges(ctx.db, on),
      decisions(ctx.db),
      cancellations(ctx.db),
      stillActive(ctx.db),
      accountNames(ctx.db),
    ]);
    const drafts = [...alertsFor(detectSeries(charges, on), status, on, acked), ...chargesAfterCancel(charges, cancelled)];
    if (drafts.length === 0) return { raised: 0 };
    const known = new Set(
      (await ctx.db.select({ key: alerts.dedupeKey }).from(alerts).where(inArray(alerts.dedupeKey, drafts.map((d) => d.dedupeKey)))).map((r) => r.key),
    );
    let raised = 0;
    for (const draft of drafts) {
      if (known.has(draft.dedupeKey)) continue;
      known.add(draft.dedupeKey);
      const text = message(draft, draft.accountId ? (names.get(draft.accountId) ?? "") : "");
      await ctx.insert(alerts, {
        kind: draft.kind,
        dedupeKey: draft.dedupeKey,
        merchant: draft.merchant,
        accountId: draft.accountId,
        transactionId: draft.transactionId,
        occurredOn: draft.occurredOn,
        ...text,
      });
      raised++;
    }
    return { raised };
  },
});

export const markAlertsNotified = defineWrite({
  name: "alerts.markNotified",
  description: "Pipeline only: record that alerts were sent to the owner's devices as push notifications.",
  // The push sender (src/lib/push/alerts.ts) after a delivery; nobody
  // marks an alert notified by hand.
  allowedActors: ["matcher"],
  input: z.object({ alertIds: z.array(z.uuid()).min(1).max(200) }),
  apply: async (ctx, { alertIds }) => {
    const now = new Date();
    const rows = await ctx.db.select({ id: alerts.id }).from(alerts).where(and(inArray(alerts.id, alertIds), isNull(alerts.notifiedAt)));
    for (const row of rows) await ctx.update(alerts, row.id, { notifiedAt: now });
    return { marked: rows.length };
  },
});

export const listAlerts = defineRead({
  name: "alerts.list",
  description: "Open alerts (not dismissed), newest first: kind, title, detail, the day it happened, and when it was raised.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  run: (db, { limit }) =>
    db
      .select({
        id: alerts.id,
        kind: alerts.kind,
        title: alerts.title,
        detail: alerts.detail,
        merchant: alerts.merchant,
        transactionId: alerts.transactionId,
        occurredOn: alerts.occurredOn,
        createdAt: alerts.createdAt,
      })
      .from(alerts)
      .where(isNull(alerts.dismissedAt))
      .orderBy(desc(alerts.occurredOn), desc(alerts.createdAt))
      .limit(limit),
});

export const dismissAlert = defineWrite({
  name: "alerts.dismiss",
  description: "Dismiss an alert. It won't be raised again for the same event.",
  input: z.object({ alertId: z.uuid() }),
  apply: async (ctx, { alertId }) => {
    const [row] = await ctx.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.id, alertId));
    if (!row) throw new NotFoundError("Alert not found");
    return ctx.update(alerts, alertId, { dismissedAt: new Date() });
  },
});
