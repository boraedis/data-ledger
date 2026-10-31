import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, notExists, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { alerts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { FLAG_KINDS, LOOKBACK_DAYS, flagsFor, isFlagKind, type Charge, type FlagKind } from "@/lib/suspicious/checks";
import { budgetAccountIds } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { accountNames } from "@/operations/recurring";
import { NotFoundError } from "@/operations/tracked";

// Suspicious-transaction checks (#33). The rules live in
// src/lib/suspicious/checks.ts; this loads what they need, raises each flag
// as an alert, and records the owner's verdict on it. Flags are alerts so
// that push (#29), Home, Tally's digest and the provisional → synced
// handover (#30) all carry them without knowing they exist.

const today = () => new Date().toISOString().slice(0, 10);
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

// How far back a nightly run looks for charges to check. The sync's window
// overlaps by five days for late-posting charges (src/lib/sync/run.ts);
// this covers that, and keeps a first 90-day backfill from raising a
// flag for every big purchase of the last three months.
export const SUBJECT_DAYS = 7;

// A charge marked suspicious stays on the review list this long, as a
// reminder to follow it up with the issuer.
const SUSPICIOUS_SHOWN_DAYS = 30;

/** Money out in budget accounts, not transfers: the same charges recurring detection reads. */
function chargeConditions(db: Db) {
  const transferCategories = db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer"));
  return [
    eq(transactions.pending, false),
    sql`${transactions.amountCents} < 0`,
    isNull(transactions.transferPairId),
    inArray(transactions.accountId, budgetAccountIds(db)),
    sql`(${transactions.categoryId} is null or ${notInArray(transactions.categoryId, transferCategories)})`,
  ];
}

const chargeColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  merchant: transactions.merchant,
  description: transactions.description,
  date: transactions.postedOn,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
  provisionalSource: transactions.provisionalSource,
  source: transactions.source,
};

type ChargeRow = {
  id: string;
  accountId: string;
  merchant: string | null;
  description: string;
  date: string;
  amountCents: number;
  categoryId: string | null;
  provisionalSource: string | null;
  source: string | null;
};

const toCharge = (r: ChargeRow): Charge => ({
  id: r.id,
  accountId: r.accountId,
  merchant: r.merchant,
  description: r.description,
  date: r.date,
  amountCents: -r.amountCents,
  categoryId: r.categoryId,
  provisional: r.provisionalSource !== null,
  manual: r.source === "manual",
});

function groupBy<T>(rows: T[], key: (row: T) => string | null) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
}

export const checkSuspicious = defineWrite({
  name: "alerts.checkSuspicious",
  description:
    "Pipeline only: check recent charges (or the given ones) for anything that looks wrong — unusually large, " +
    "a first-time merchant above a threshold, a likely duplicate, a foreign transaction fee — and raise an alert for each.",
  // The nightly pass and the Apple Pay route, as matcher; the owner may run
  // it by hand. Not Tally: it would only be proposing a pipeline run.
  allowedActors: ["matcher", "user"],
  input: z.object({
    on: z.iso.date().optional(),
    // Just these: a purchase alert checking its own charge as it arrives.
    transactionIds: z.array(z.uuid()).min(1).max(50).optional(),
  }),
  apply: async (ctx, { on = today(), transactionIds }) => {
    const db = ctx.db;
    const subjects = (
      await db
        .select(chargeColumns)
        .from(transactions)
        .where(
          and(
            ...chargeConditions(db),
            // Synced and provisional charges only. A CSV import (#35) is old
            // history, and a charge the owner typed in (#64) is theirs.
            isNull(transactions.source),
            transactionIds ? inArray(transactions.id, transactionIds) : and(gte(transactions.postedOn, shift(on, -SUBJECT_DAYS)), lte(transactions.postedOn, on)),
            // Anything an alert is already about — a flag from an earlier run,
            // one that followed a purchase alert to its synced copy, or a
            // subscription alert that said it first — isn't flagged again.
            notExists(db.select({ id: alerts.id }).from(alerts).where(eq(alerts.transactionId, transactions.id))),
          ),
        )
    ).map(toCharge);
    if (subjects.length === 0) return { raised: 0, alertIds: [] as string[] };

    const merchants = [...new Set(subjects.map((s) => s.merchant).filter((m): m is string => m !== null))];
    const categoryIds = [...new Set(subjects.map((s) => s.categoryId).filter((c): c is string => c !== null))];
    const dates = subjects.map((s) => s.date).sort();
    const from = shift(dates[0], -LOOKBACK_DAYS);
    const to = shift(dates[dates.length - 1], 1);
    const window = and(...chargeConditions(db), gte(transactions.postedOn, from), lte(transactions.postedOn, to));

    const ranked = db
      .select({
        merchant: transactions.merchant,
        id: transactions.id,
        date: transactions.postedOn,
        rank: sql<number>`row_number() over (partition by ${transactions.merchant} order by ${transactions.postedOn}, ${transactions.id})`.as("rank"),
      })
      .from(transactions)
      // Any transaction at all counts as having been there before, a refund
      // included. Not a provisional one: its synced copy will be the record.
      .where(and(merchants.length ? inArray(transactions.merchant, merchants) : sql`false`, isNull(transactions.provisionalSource)))
      .as("ranked");

    const [atMerchants, inCategories, earliest, verdicts, names, cats] = await Promise.all([
      merchants.length ? db.select(chargeColumns).from(transactions).where(and(window, inArray(transactions.merchant, merchants))) : [],
      categoryIds.length ? db.select(chargeColumns).from(transactions).where(and(window, inArray(transactions.categoryId, categoryIds))) : [],
      merchants.length ? db.select().from(ranked).where(lte(ranked.rank, 2)) : [],
      db
        .select({ kind: alerts.kind, merchant: alerts.merchant, amountCents: alerts.amountCents, verdict: alerts.verdict, at: alerts.dismissedAt })
        .from(alerts)
        .where(and(isNotNull(alerts.verdict), isNotNull(alerts.dismissedAt))),
      accountNames(db),
      db.select({ id: categories.id, name: categories.name }).from(categories),
    ]);
    const categoryName = new Map(cats.map((c) => [c.id, c.name]));

    const drafts = flagsFor(subjects, {
      byMerchant: groupBy(atMerchants.map(toCharge), (c) => c.merchant),
      byCategory: groupBy(inCategories.map(toCharge), (c) => c.categoryId),
      earliest: groupBy(earliest, (e) => e.merchant),
      accountName: (id) => names.get(id) ?? "",
      categoryName: (id) => categoryName.get(id) ?? "this category",
      verdicts: verdicts
        .filter((v) => isFlagKind(v.kind))
        .map((v) => ({ kind: v.kind as FlagKind, merchant: v.merchant, amountCents: v.amountCents, verdict: v.verdict!, at: v.at! })),
    });
    if (drafts.length === 0) return { raised: 0, alertIds: [] as string[] };

    const known = new Set(
      (await db.select({ key: alerts.dedupeKey }).from(alerts).where(inArray(alerts.dedupeKey, drafts.map((d) => d.dedupeKey)))).map((r) => r.key),
    );
    const alertIds: string[] = [];
    for (const draft of drafts) {
      if (known.has(draft.dedupeKey)) continue;
      const row = await ctx.insert(alerts, draft);
      alertIds.push(row.id);
    }
    return { raised: alertIds.length, alertIds };
  },
});

export const reviewFlag = defineWrite({
  name: "alerts.review",
  description:
    "Answer a suspicious-charge alert: fine (it's yours; the checks learn from it) or suspicious (worth disputing). " +
    "Either way it leaves the review list.",
  input: z.object({ alertId: z.uuid(), verdict: z.enum(["fine", "suspicious"]) }),
  apply: async (ctx, { alertId, verdict }) => {
    const [row] = await ctx.db.select({ id: alerts.id, kind: alerts.kind }).from(alerts).where(eq(alerts.id, alertId));
    if (!row) throw new NotFoundError("Alert not found");
    // A subscription alert has nothing to tune; it's dismissed instead.
    if (!isFlagKind(row.kind)) throw new Error("Only a suspicious-charge alert takes a verdict; dismiss this one instead");
    // Changing an earlier answer is allowed: the latest one is what counts.
    return ctx.update(alerts, alertId, { verdict, dismissedAt: new Date() });
  },
});

export const listFlags = defineRead({
  name: "alerts.flagged",
  description:
    "Suspicious-charge alerts: those waiting for a verdict, and those marked suspicious in the last 30 days, with " +
    "the one-line reason each was flagged.",
  input: z.object({}),
  run: async (db) => {
    const columns = {
      id: alerts.id,
      kind: alerts.kind,
      title: alerts.title,
      detail: alerts.detail,
      merchant: alerts.merchant,
      accountId: alerts.accountId,
      transactionId: alerts.transactionId,
      occurredOn: alerts.occurredOn,
      amountCents: alerts.amountCents,
    };
    const kinds = inArray(alerts.kind, FLAG_KINDS);
    const [open, suspicious] = await Promise.all([
      db.select(columns).from(alerts).where(and(kinds, isNull(alerts.dismissedAt))).orderBy(desc(alerts.occurredOn), desc(alerts.createdAt)),
      db
        .select(columns)
        .from(alerts)
        .where(and(kinds, eq(alerts.verdict, "suspicious"), gte(alerts.dismissedAt, new Date(Date.now() - SUSPICIOUS_SHOWN_DAYS * 86_400_000))))
        .orderBy(desc(alerts.dismissedAt)),
    ]);
    return { open, suspicious };
  },
});
