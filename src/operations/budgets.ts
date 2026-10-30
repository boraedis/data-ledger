import { randomUUID } from "crypto";
import { and, eq, inArray, isNull, min } from "drizzle-orm";
import { z } from "zod";
import { budgetAdjustments, budgetTargets, categories, payStubDeposits, payStubs, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  BUFFER,
  budgetStatus as computeStatus,
  changeEffectiveFrom,
  currentVersion,
  firstOfMonth,
  HISTORY_MONTHS,
  lastOfMonth,
  monthIndex,
  monthlySeries,
  recentHistory,
  SERIES_MONTHS,
  yearSummary,
  type TargetVersion,
} from "@/lib/budgets/engine";
import { categoryOptions } from "@/lib/categorize/labels";
import { defineRead, defineWrite } from "@/operations/define";
import type { Series } from "@/lib/recurring/detect";
import { budgetAccountIds } from "@/operations/accounts";
import { detectedSeries } from "@/operations/recurring";
import { spendingLines, uncategorizedSpend } from "@/operations/transactions";
import { payForMonth, paySummary } from "@/lib/budgets/pay";
import type { WriteContext } from "@/operations/tracked";

// Budgets (#7): category targets with periods, rollover and an unallocated
// buffer. The rules live in src/lib/budgets/engine.ts; these operations
// load the data, validate, and write versions and adjustments as tracked
// (undoable) rows. Budget figures are derived from transactions — no
// balances — so Tally may read them like any spending question.

const today = () => new Date().toISOString().slice(0, 10);
const isoDate = z.iso.date();
// Null (or omitted) is the buffer: "everything without its own target".
const targetCategory = z.uuid().nullable();

async function loadVersions(db: Db): Promise<TargetVersion[]> {
  return db
    .select({
      categoryId: budgetTargets.categoryId,
      effectiveFrom: budgetTargets.effectiveFrom,
      amountCents: budgetTargets.amountCents,
      periodMonths: budgetTargets.periodMonths,
      anchorOn: budgetTargets.anchorOn,
      rollover: budgetTargets.rollover,
      sinkingFund: budgetTargets.sinkingFund,
    })
    .from(budgetTargets);
}

async function labels(db: Db) {
  const rows = await db.select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId }).from(categories);
  return { rows, labelOf: new Map(categoryOptions(rows).map((o) => [o.id, o.label])) };
}

const nameFor = (labelOf: Map<string, string>, categoryId: string | null) =>
  categoryId ? (labelOf.get(categoryId) ?? "Unknown category") : "Everything else (buffer)";

export const budgetStatus = defineRead({
  name: "budgets.status",
  description:
    "Budget status on a date (default today): for each target in effect, its current period (start/end), " +
    "target, rollover carried in, rebalancing adjustments, available, net spent and remaining, in cents. " +
    "Multi-month targets add an even-pace expected spend and, if a sinking fund, the monthly set-aside. " +
    "The buffer (categoryId null) covers every expense category without its own target; `unbudgeted` " +
    "lists what drew from it this period by category, and `covers` every category it covers today, $0 included. Net of shared expenses (your share counts) unless " +
    "gross is true.",
  input: z.object({ on: isoDate.optional(), gross: z.boolean().default(false) }),
  run: async (db, { on = today(), gross }) => {
    const versions = await loadVersions(db);
    const earliest = versions.reduce((min, v) => (v.effectiveFrom < min ? v.effectiveFrom : min), on.slice(0, 8) + "01");
    const [lines, { rows, labelOf }, adjustments] = await Promise.all([
      spendingLines.run(db, { from: earliest, to: on, budgetOnly: true, gross }),
      labels(db),
      db.select({ categoryId: budgetAdjustments.categoryId, on: budgetAdjustments.on, amountCents: budgetAdjustments.amountCents }).from(budgetAdjustments),
    ]);
    const status = computeStatus({
      on,
      versions,
      lines: lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId })),
      categories: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
      adjustments,
    });
    return {
      on: status.on,
      targets: status.targets.map(({ key, ...t }) => {
        const categoryId = key === BUFFER ? null : key;
        return { categoryId, name: nameFor(labelOf, categoryId), ...t };
      }),
      unbudgeted: {
        ...status.unbudgeted,
        byCategory: status.unbudgeted.byCategory.map((c) => ({ ...c, name: nameFor(labelOf, c.categoryId) })),
        // Every expense category the buffer covers today (no target of its
        // own or its parent's, as the engine resolves lines), with what it
        // drew this period, $0 included (#110). Built on byCategory, so it
        // always adds up to what the buffer counted, even for a category
        // whose target changed within the period.
        covers: [
          ...status.unbudgeted.byCategory,
          ...rows
            .filter((r) => r.kind === "expense")
            .filter((r) => !currentVersion(versions, r.id, on) && !(r.parentId && currentVersion(versions, r.parentId, on)))
            .filter((r) => !status.unbudgeted.byCategory.some((c) => c.categoryId === r.id))
            .map((r) => ({ categoryId: r.id, spentCents: 0 })),
        ].map((c) => ({ ...c, name: nameFor(labelOf, c.categoryId) })),
      },
    };
  },
});

export const budgetHistory = defineRead({
  name: "budgets.history",
  description:
    `What each expense category (and the buffer, categoryId null) usually costs: net spend in each of the last ` +
    `${HISTORY_MONTHS} full months before \`on\` (default today; the current month is left out) and their average, ` +
    "in cents. A category covers its own spending and its subcategories' without their own target, as a target on " +
    "it would today. averageCents is null with no spending in the window (no history, not $0). For a monthly " +
    "target, overMonths of comparedMonths went over today's target. Net unless gross is true.",
  input: z.object({ on: isoDate.optional(), gross: z.boolean().default(false) }),
  run: async (db, { on = today(), gross }) => {
    const end = monthIndex(on) - 1;
    const [versions, lines, { rows, labelOf }] = await Promise.all([
      loadVersions(db),
      // The same lines budgets.status counts, for the window only.
      spendingLines.run(db, { from: firstOfMonth(end - HISTORY_MONTHS + 1), to: lastOfMonth(end), budgetOnly: true, gross }),
      labels(db),
    ]);
    const history = recentHistory({
      on,
      versions,
      lines: lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId })),
      categories: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
    });
    return [...history.values()].map(({ key, ...h }) => {
      const categoryId = key === BUFFER ? null : key;
      return { categoryId, name: nameFor(labelOf, categoryId), ...h };
    });
  },
});

export const budgetMonthly = defineRead({
  name: "budgets.monthly",
  description:
    `Each current target's net spend in each of the last \`months\` (default ${SERIES_MONTHS}) up to and including \`on\`'s ` +
    "(default today; that month is partial), in cents, with every month listed ($0 when nothing was spent). " +
    "Where the target was in effect, a month is what budgets.status counted toward it, and targetCents is its " +
    "monthly amount then (a multi-month target's even monthly share); before it existed, targetCents is null " +
    "and the month shows what the target would cover today. `months` widens the window (up to 24); " +
    "`includeEnded` also lists targets in effect during the window but not on `on`. Net unless gross is true.",
  input: z.object({
    on: isoDate.optional(),
    gross: z.boolean().default(false),
    months: z.number().int().min(1).max(24).default(SERIES_MONTHS),
    includeEnded: z.boolean().default(false),
  }),
  run: async (db, { on = today(), gross, months, includeEnded }) => {
    // One read of the whole window's lines, however many cells it fills.
    const [versions, lines, { rows, labelOf }] = await Promise.all([
      loadVersions(db),
      spendingLines.run(db, { from: firstOfMonth(monthIndex(on) - months + 1), to: on, budgetOnly: true, gross }),
      labels(db),
    ]);
    const series = monthlySeries({
      on,
      versions,
      lines: lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId })),
      categories: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
      months,
      includeEnded,
    });
    return [...series].map(([key, months]) => {
      const categoryId = key === BUFFER ? null : key;
      return { categoryId, name: nameFor(labelOf, categoryId), months };
    });
  },
});

export const budgetYear = defineRead({
  name: "budgets.year",
  description:
    "Every target's calendar year, and the total: the target and net spending of each of its periods in the year, at " +
    "the version each period had (a target changed mid-year counts each period at its own amount; an ended one counts " +
    "for the periods it covered). The current year's later periods count in full toward the target, with spending so " +
    "far. A period straddling the year (an annual target starting in April) counts the year's months of it, pro rata. " +
    "remainingCents is target less spent; negative is over. Net unless gross is true.",
  input: z.object({ year: z.number().int().min(2000).max(2100), gross: z.boolean().default(false) }),
  run: async (db, { year, gross }) => {
    const [versions, lines, { rows, labelOf }] = await Promise.all([
      loadVersions(db),
      spendingLines.run(db, { from: `${year}-01-01`, to: `${year}-12-31`, budgetOnly: true, gross }),
      labels(db),
    ]);
    const targets = yearSummary({
      year,
      versions,
      lines: lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId })),
      categories: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
    }).map(({ key, ...t }) => {
      const categoryId = key === BUFFER ? null : key;
      return { categoryId, name: nameFor(labelOf, categoryId), ...t, remainingCents: t.targetCents - t.spentCents };
    });
    // The buffer first, then by name, as the Year view lists them.
    targets.sort((a, b) => (a.categoryId === null ? -1 : b.categoryId === null ? 1 : a.name.localeCompare(b.name)));
    const sum = (pick: (t: (typeof targets)[number]) => number) => targets.reduce((s, t) => s + pick(t), 0);
    return {
      year,
      targets,
      total: { targetCents: sum((t) => t.targetCents), spentCents: sum((t) => t.spentCents), remainingCents: sum((t) => t.remainingCents) },
    };
  },
});

export const budgetPay = defineRead({
  name: "budgets.pay",
  description:
    "The month's pay against its budget (as of `on`, default today), in cents and as a % of net pay: net pay (the " +
    "month's pay stubs by pay date, plus in the current month paychecks still to come at the recent pace), total " +
    "targets (each target in effect at its monthly share, buffer included), expected saving (pay less targets), " +
    "spending so far (net spend in expense categories, budget accounts) and actual saving (pay less spending). " +
    "Transfers, savings included, and pay are never spending; deductions taken from a paycheck before it landed " +
    "aren't either, since net pay is already after them. netPay is null when no pay was recorded or expected. " +
    "Spending is net of shared expenses unless gross is true.",
  allowedActors: ["user"],
  input: z.object({ on: isoDate.optional(), gross: z.boolean().default(false), today: isoDate.optional() }),
  run: async (db, { on = today(), gross, today: day }) => {
    const now = day ?? today();
    const month = on.slice(0, 7);
    const from = `${month}-01`;
    const [stubs, versions, lines, deposits, { rows }, uncategorized] = await Promise.all([
      db.select({ payDate: payStubs.payDate, periodStart: payStubs.periodStart, periodEnd: payStubs.periodEnd, netCents: payStubs.netCents, oneTime: payStubs.oneTime }).from(payStubs),
      loadVersions(db),
      spendingLines.run(db, { from, to: on, budgetOnly: true, gross }),
      db.select({ transactionId: payStubDeposits.transactionId }).from(payStubDeposits),
      labels(db),
      uncategorizedSpend.run(db, { from, to: on }),
    ]);
    const pay = payForMonth(month, now, stubs);

    // Each target in effect at its monthly share: a month's own target, or a
    // twelfth of an annual one, so a month with an annual target isn't
    // measured against the whole year's budget.
    const keys = [...new Set(versions.map((v) => v.categoryId))];
    const targetsCents = keys.reduce((sum, id) => {
      const v = currentVersion(versions, id, on);
      return v ? sum + Math.round(v.amountCents! / v.periodMonths) : sum;
    }, 0);

    // Spending: expense lines only (transfers and pay never are). A linked
    // paycheck's deduction lines (health insurance under an expense
    // category, say) left the gross before net pay landed, so against net
    // pay they'd count twice.
    const expense = new Set(rows.filter((r) => r.kind === "expense").map((r) => r.id));
    const paycheck = new Set(deposits.map((d) => d.transactionId));
    const spentCents = -lines.filter((l) => expense.has(l.categoryId) && !paycheck.has(l.transactionId)).reduce((sum, l) => sum + l.amountCents, 0);

    return {
      month,
      pay,
      summary: pay.netPayCents === null ? null : paySummary({ netPayCents: pay.netPayCents, targetsCents, spentCents }),
      targetsCents,
      spentCents,
      // Money out not categorized yet isn't in spending; said so, not hidden.
      uncategorized,
    };
  },
});

export const yearlyCharges = defineRead({
  name: "budgets.yearlyCharges",
  description:
    "Annual charges found by recurring-charge detection (two charges about a year apart, still current, not " +
    "dismissed or cancelled on Subscriptions), grouped by the expense category of their latest charge: a starting " +
    "point for an annual sinking-fund target. amountCents is the latest charge (summed when a category has several), " +
    "setAsideMonthlyCents a twelfth of it, and anchorMonth the month after the largest one's last charge, so the " +
    "year being saved for ends with its next charge. Nothing is written; the owner sets the target.",
  input: z.object({ on: isoDate.optional() }),
  run: async (db, { on = today() }) => {
    // Subscriptions or not: an insurance premium or a yearly registration is
    // as much a budget-wrecker as a software plan, and detection already
    // finds any merchant charged on a yearly rhythm. What the owner has said
    // isn't recurring (dismissed) or has ended (cancelled) is left out.
    const annual = (await detectedSeries(db, on)).filter(
      ({ series, status }) => series.cadence.name === "annual" && series.active && status !== "dismissed" && status !== "cancelled",
    );
    if (annual.length === 0) return [];
    const lastIds = annual.map(({ series }) => series.occurrences.at(-1)!.chargeIds[0]);
    const [rows, { rows: cats, labelOf }] = await Promise.all([
      db.select({ id: transactions.id, categoryId: transactions.categoryId }).from(transactions).where(inArray(transactions.id, lastIds)),
      labels(db),
    ]);
    const categoryOf = new Map(rows.map((r) => [r.id, r.categoryId]));
    const expense = new Set(cats.filter((c) => c.kind === "expense").map((c) => c.id));

    const byCategory = new Map<string, Series[]>();
    for (const { series } of annual) {
      const categoryId = categoryOf.get(series.occurrences.at(-1)!.chargeIds[0]);
      // Uncategorized, or filed somewhere a target can't go: nothing to suggest yet.
      if (!categoryId || !expense.has(categoryId)) continue;
      byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), series]);
    }
    return [...byCategory].map(([categoryId, list]) => {
      const largest = list.reduce((a, b) => (b.latestCents > a.latestCents ? b : a));
      const amountCents = list.reduce((sum, s) => sum + s.latestCents, 0);
      return {
        categoryId,
        name: nameFor(labelOf, categoryId),
        charges: list.map((s) => ({ merchant: s.merchant, latestCents: s.latestCents, lastOn: s.lastOn, nextExpectedOn: s.nextExpectedOn })),
        amountCents,
        setAsideMonthlyCents: Math.round(amountCents / 12),
        anchorMonth: firstOfMonth(monthIndex(largest.lastOn) + 1).slice(0, 7),
      };
    });
  },
});

export const listTargets = defineRead({
  name: "budgets.targets",
  description:
    "Every budget target's version history, oldest first: effectiveFrom, amount (null = ended), period length " +
    "in months (1 monthly, 12 annual, else custom), anchor month, rollover and sinking-fund flags.",
  input: z.object({}),
  run: async (db) => {
    const [versions, { labelOf }] = await Promise.all([db.select().from(budgetTargets).orderBy(budgetTargets.effectiveFrom), labels(db)]);
    return versions.map((v) => ({ ...v, name: nameFor(labelOf, v.categoryId) }));
  },
});

async function assertExpenseCategory(ctx: WriteContext, categoryId: string | null) {
  if (categoryId === null) return;
  const [row] = await ctx.db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId));
  if (!row) throw new Error("Category not found");
  if (row.kind !== "expense") throw new Error("Only expense categories take budget targets");
}

/** Inserts a version, or corrects the one already starting on that date. */
async function writeVersion(ctx: WriteContext, values: Omit<typeof budgetTargets.$inferInsert, "id" | "createdAt">) {
  const sameStart = and(
    values.categoryId ? eq(budgetTargets.categoryId, values.categoryId) : isNull(budgetTargets.categoryId),
    eq(budgetTargets.effectiveFrom, values.effectiveFrom),
  );
  const [existing] = await ctx.db.select({ id: budgetTargets.id }).from(budgetTargets).where(sameStart);
  return existing ? ctx.update(budgetTargets, existing.id, values) : ctx.insert(budgetTargets, values);
}

export const setTarget = defineWrite({
  name: "budgets.setTarget",
  description:
    "Set or change a budget target: amountCents per period for an expense category (categoryId null = the " +
    "buffer). periodMonths 1 = monthly, 12 = annual, other = custom; anchorMonth (YYYY-MM) is when periods " +
    "start counting (default January for annual, else this month). A change applies from the start of the " +
    "current period; earlier periods keep their old target.",
  input: z.object({
    categoryId: targetCategory,
    amountCents: z.number().int().min(1).max(100_000_000_00),
    periodMonths: z.number().int().min(1).max(24).default(1),
    anchorMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    rollover: z.boolean().default(false),
    sinkingFund: z.boolean().default(false),
    // The day the change is made; defaults to today. Lets the command log
    // say exactly which period a change took effect from.
    today: isoDate.optional(),
  }),
  apply: async (ctx, input) => {
    await assertExpenseCategory(ctx, input.categoryId);
    const on = input.today ?? today();
    const anchorOn = input.anchorMonth
      ? `${input.anchorMonth}-01`
      : input.periodMonths === 12
        ? `${on.slice(0, 4)}-01-01`
        : `${on.slice(0, 7)}-01`;
    const current = currentVersion(await loadVersions(ctx.db), input.categoryId, on);
    const effectiveFrom = changeEffectiveFrom(current, { periodMonths: input.periodMonths, anchorOn }, on);
    const row = await writeVersion(ctx, {
      categoryId: input.categoryId,
      effectiveFrom,
      amountCents: input.amountCents,
      periodMonths: input.periodMonths,
      anchorOn,
      rollover: input.rollover,
      // A one-month period has nothing to set aside for.
      sinkingFund: input.sinkingFund && input.periodMonths > 1,
    });
    return { id: row.id, effectiveFrom };
  },
});

// --- Backdating a target (#130) -------------------------------------------------
//
// After backfilling a year of transactions, earlier months have spending
// and nothing to measure it against. A target can be given an earlier
// start, but only where no target was in effect: it fills a gap, running
// until the target's next version, and never rewrites a month that
// already had one (which would silently change what that month was held
// to). The earliest it can start is the first month with transactions.

/** The first month (YYYY-MM) with spending in budget accounts, or null. */
async function earliestMonth(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ first: min(transactions.postedOn) })
    .from(transactions)
    .where(inArray(transactions.accountId, budgetAccountIds(db)));
  return row?.first ? String(row.first).slice(0, 7) : null;
}

export const backdateRange = defineRead({
  name: "budgets.backdateRange",
  description:
    "How far back a target can be backdated (budgets.backdateTarget): the first month with transactions in budget " +
    "accounts (YYYY-MM, null with none), and this month, which backdating stops short of.",
  input: z.object({ today: isoDate.optional() }),
  run: async (db, { today: day }) => ({ earliestMonth: await earliestMonth(db), currentMonth: (day ?? today()).slice(0, 7) }),
});

export const backdateTarget = defineWrite({
  name: "budgets.backdateTarget",
  description:
    "Give a target (categoryId null = the buffer) an earlier start: amountCents per period from fromMonth (YYYY-MM), " +
    "running until the target's next version, which keeps its amount. Only where no target was in effect from " +
    "fromMonth on; never earlier than the first month with transactions, and before this month (budgets.setTarget " +
    "covers this period). periodMonths, anchorMonth (default January for annual, else fromMonth), rollover and " +
    "sinkingFund as in budgets.setTarget. With rollover, what later periods have available changes.",
  input: z.object({
    categoryId: targetCategory,
    fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amountCents: z.number().int().min(1).max(100_000_000_00),
    periodMonths: z.number().int().min(1).max(24).default(1),
    anchorMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    rollover: z.boolean().default(false),
    sinkingFund: z.boolean().default(false),
    today: isoDate.optional(),
  }),
  apply: async (ctx, input) => {
    await assertExpenseCategory(ctx, input.categoryId);
    const on = input.today ?? today();
    if (input.fromMonth >= on.slice(0, 7)) throw new Error("That's this month or later: set the target as usual instead");
    const first = await earliestMonth(ctx.db);
    if (!first || input.fromMonth < first) throw new Error(`The earliest a target can start is ${first ?? "the first month with transactions"}`);

    const effectiveFrom = `${input.fromMonth}-01`;
    const versions = (await loadVersions(ctx.db)).filter((v) => v.categoryId === input.categoryId);
    if (currentVersion(versions, input.categoryId, effectiveFrom)) {
      throw new Error("A target was already in effect then. Backdating only fills months that had none, so past months keep what they were held to");
    }
    const anchorOn = input.anchorMonth ? `${input.anchorMonth}-01` : input.periodMonths === 12 ? `${input.fromMonth.slice(0, 4)}-01-01` : effectiveFrom;
    const next = versions.filter((v) => v.effectiveFrom > effectiveFrom).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
    const row = await writeVersion(ctx, {
      categoryId: input.categoryId,
      effectiveFrom,
      amountCents: input.amountCents,
      periodMonths: input.periodMonths,
      anchorOn,
      rollover: input.rollover,
      sinkingFund: input.sinkingFund && input.periodMonths > 1,
    });
    // Until the next version, or open-ended when there's none (it becomes the current target).
    return { id: row.id, effectiveFrom, until: next ? next.effectiveFrom : null };
  },
});

export const removeTarget = defineWrite({
  name: "budgets.removeTarget",
  description:
    "End a budget target from the start of its current period (categoryId null = the buffer). Its history " +
    "stays; its category's spending falls to the buffer from then on.",
  input: z.object({ categoryId: targetCategory, today: isoDate.optional() }),
  apply: async (ctx, { categoryId, today: day }) => {
    const on = day ?? today();
    const current = currentVersion(await loadVersions(ctx.db), categoryId, on);
    if (!current) throw new Error("There's no target to remove");
    const effectiveFrom = changeEffectiveFrom(current, current, on);
    await writeVersion(ctx, { ...current, categoryId, effectiveFrom, amountCents: null });
    return { effectiveFrom };
  },
});

export const rebalance = defineWrite({
  name: "budgets.rebalance",
  description:
    "Move budget between two targets for the current period only (e.g. $50 from Dining to Car this month), " +
    "without changing either target. categoryId null = the buffer. Both need a target in effect.",
  input: z.object({
    fromCategoryId: targetCategory,
    toCategoryId: targetCategory,
    amountCents: z.number().int().min(1).max(100_000_000_00),
    on: isoDate.optional(),
  }),
  apply: async (ctx, { fromCategoryId, toCategoryId, amountCents, on = today() }) => {
    if (fromCategoryId === toCategoryId) throw new Error("Pick two different targets");
    const versions = await loadVersions(ctx.db);
    for (const id of [fromCategoryId, toCategoryId]) {
      if (!currentVersion(versions, id, on)) throw new Error(`${id ? "That category" : "The buffer"} has no target to move budget ${id === fromCategoryId ? "from" : "to"}`);
    }
    const rebalanceId = randomUUID();
    await ctx.insert(budgetAdjustments, { rebalanceId, categoryId: fromCategoryId, on, amountCents: -amountCents });
    await ctx.insert(budgetAdjustments, { rebalanceId, categoryId: toCategoryId, on, amountCents });
    return { rebalanceId };
  },
});
