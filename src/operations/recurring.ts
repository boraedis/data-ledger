import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, alerts, categories, recurringSeries, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { formatCents } from "@/lib/money";
import { alertsFor, detectSeries, seriesKey, type AlertDraft, type Series } from "@/lib/recurring/detect";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError } from "@/operations/tracked";

// Recurring charges and alerts (#9). Detection is computed on read from
// recent spending (src/lib/recurring/detect.ts); the owner's confirm/dismiss
// decisions and the raised alerts are the stored state. alerts.refresh runs
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

async function accountNames(db: Db) {
  const rows = await db.select({ id: accounts.id, name: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})` }).from(accounts);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function describe(series: Series, status: "confirmed" | "dismissed" | undefined, accountName: string) {
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
  };
}

export const listRecurring = defineRead({
  name: "recurring.list",
  description:
    "Recurring charges detected from merchant, cadence and amount (one merchant in one account), with status " +
    "(suggested, confirmed by the owner as a subscription/bill, or dismissed), cadence, usual and latest amount " +
    "in cents, next expected charge, and annualized cost. `active` is false when charges have stopped.",
  input: z.object({ on: z.iso.date().optional() }),
  run: async (db, { on = today() }) => {
    const [charges, status, names] = await Promise.all([loadCharges(db, on), decisions(db), accountNames(db)]);
    return detectSeries(charges, on).map((s) => describe(s, status.get(s.key), names.get(s.accountId) ?? ""));
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
    if (existing) await ctx.update(recurringSeries, existing.id, { status });
    else await ctx.insert(recurringSeries, { merchant, accountId, status });
    return { status };
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
        title: `${m} didn't charge`,
        detail: `Usually ${formatCents(draft.toCents!)} ${draft.cadence}; it was due around ${draft.occurredOn}${where}. Cancelled, or a card problem?`,
      };
  }
}

export const refreshAlerts = defineWrite({
  name: "alerts.refresh",
  description: "Pipeline only: raise new alerts from recurring-charge detection. Each event is raised once.",
  allowedActors: ["matcher", "user"],
  input: z.object({ on: z.iso.date().optional() }),
  apply: async (ctx, { on = today() }) => {
    const [charges, status, names] = await Promise.all([loadCharges(ctx.db, on), decisions(ctx.db), accountNames(ctx.db)]);
    const drafts = alertsFor(detectSeries(charges, on), status, on);
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
