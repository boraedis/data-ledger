import { randomUUID } from "crypto";
import { and, eq, inArray, isNull, min } from "drizzle-orm";
import { z } from "zod";
import { accounts, budgetAdjustments, budgetTargets, categories, payStubDeposits, payStubs, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  BUFFER,
  budgetStatus as computeStatus,
  changeEffectiveFrom,
  currentVersion,
  firstOfMonth,
  HISTORY_MONTHS,
  keyOf,
  lastOfMonth,
  linesForTarget,
  monthIndex,
  monthlySeries,
  naturalPeriod,
  periodsByKey,
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
import { payForMonth, paySummary, typicalMonth } from "@/lib/budgets/pay";
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

export const targetTransactions = defineRead({
  name: "budgets.targetTransactions",
  description:
    "The transactions behind one target's spent figure (categoryId null = the buffer) in its period as of `on` " +
    "(default today): every line budgets.status counted toward it, one per transaction or split part, dated as budgets " +
    "date them (experience date when set), net of shared expenses unless gross is true. Refunds are positive and " +
    "reduce the total. totalCents always equals the target's spentCents. Transfers and income are never in it.",
  input: z.object({ categoryId: targetCategory, on: isoDate.optional(), gross: z.boolean().default(false) }),
  run: async (db, { categoryId, on = today(), gross }) => {
    const status = await budgetStatus.run(db, { on, gross });
    const target = status.targets.find((t) => t.categoryId === categoryId);
    if (!target) return null;
    const [versions, lines, { rows, labelOf }] = await Promise.all([
      loadVersions(db),
      // The same lines the card is built from, for its period so far.
      spendingLines.run(db, { from: target.start, to: on < target.end ? on : target.end, budgetOnly: true, gross }),
      labels(db),
    ]);
    const counted = linesForTarget({
      key: categoryId ?? BUFFER,
      start: target.start,
      end: target.end,
      versions,
      lines,
      categories: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
    });
    const ids = [...new Set(counted.map((l) => l.transactionId))];
    const details = ids.length
      ? await db
          .select({ id: transactions.id, description: transactions.description, isSplit: transactions.isSplit, accountName: accounts.name })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(inArray(transactions.id, ids))
      : [];
    const byId = new Map(details.map((d) => [d.id, d]));
    const lineRows = counted
      .map((l) => ({
        transactionId: l.transactionId,
        date: l.date,
        description: byId.get(l.transactionId)?.description ?? "",
        merchant: l.merchant,
        accountName: byId.get(l.transactionId)?.accountName ?? "",
        categoryName: labelOf.get(l.categoryId) ?? "Unknown category",
        // A part of a split transaction rather than all of it.
        splitPart: byId.get(l.transactionId)?.isSplit ?? false,
        amountCents: l.amountCents,
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.amountCents - b.amountCents);
    return {
      categoryId,
      name: target.name,
      start: target.start,
      end: target.end,
      spentCents: target.spentCents,
      totalCents: -lineRows.reduce((sum, l) => sum + l.amountCents, 0),
      lines: lineRows,
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
    "`includeEnded` also lists targets in effect during the window but not on `on`. Each month counts its transactions. " +
    "`details` adds, for a month with a target, the period it falls in as budgets.status had it then: dates, target, " +
    "rollover carried in, rebalancing, available, and whether it rolls over. `moved` adds movedCents to each month: " +
    "budget moved into (+) or out of (−) the target that month by budgets.rebalance. Net unless gross is true.",
  input: z.object({
    on: isoDate.optional(),
    gross: z.boolean().default(false),
    months: z.number().int().min(1).max(24).default(SERIES_MONTHS),
    includeEnded: z.boolean().default(false),
    details: z.boolean().default(false),
    moved: z.boolean().default(false),
  }),
  run: async (db, { on = today(), gross, months, includeEnded, details, moved }) => {
    const windowStart = firstOfMonth(monthIndex(on) - months + 1);
    const versions = await loadVersions(db);
    // Rollover carries from the target's first period, so with details the
    // lines go back that far; otherwise one read of the window, however many
    // cells it fills.
    const earliest = details ? versions.reduce((min, v) => (v.effectiveFrom < min ? v.effectiveFrom : min), windowStart) : windowStart;
    const [lines, { rows, labelOf }, adjustments] = await Promise.all([
      spendingLines.run(db, { from: earliest, to: on, budgetOnly: true, gross }),
      labels(db),
      details || moved
        ? db.select({ categoryId: budgetAdjustments.categoryId, on: budgetAdjustments.on, amountCents: budgetAdjustments.amountCents }).from(budgetAdjustments)
        : [],
    ]);
    const categoryInfo = rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind }));
    const spend = lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId, transactionId: l.transactionId }));
    const series = monthlySeries({ on, versions, lines: spend.filter((l) => l.date >= windowStart), categories: categoryInfo, months, includeEnded });
    const periods = details ? periodsByKey({ on, versions, lines: spend, categories: categoryInfo, adjustments }) : null;
    return [...series].map(([key, bars]) => {
      const categoryId = key === BUFFER ? null : key;
      const own = periods?.get(key) ?? [];
      // Rebalancing (#146) by the month it was made in: each move is a pair
      // that nets to zero, so it shifts targets between rows without
      // changing a month's total.
      const movedIn = (month: string) =>
        adjustments.filter((a) => keyOf(a.categoryId) === key && a.on.slice(0, 7) === month.slice(0, 7)).reduce((sum, a) => sum + a.amountCents, 0);
      return {
        categoryId,
        name: nameFor(labelOf, categoryId),
        months: bars.map((bar) => {
          const b = moved ? { ...bar, movedCents: movedIn(bar.month) } : bar;
          if (!periods || b.targetCents === null) return b;
          const p = own.find((x) => x.start <= b.month && b.month <= x.end);
          return {
            ...b,
            period: p
              ? { start: p.start, end: p.end, periodMonths: p.periodMonths, targetCents: p.targetCents, carryInCents: p.carryInCents, adjustmentsCents: p.adjustmentsCents, availableCents: p.availableCents, spentCents: p.spentCents, rollover: p.rollover }
              : null,
          };
        }),
      };
    });
  },
});

// A period day by day (#149): one target's current period and its last
// `past` complete periods, or (categoryId omitted) the month's monthly
// targets together and the months before, as the Month view totals them.
// Multi-month targets stay out of the month-wide figures, as they do from
// "Total this month". Only each line's date and amount: the page draws
// the burndown and the calendar from them (lib/budgets/burndown.ts).
export const budgetDaily = defineRead({
  name: "budgets.daily",
  description:
    "Day-by-day spending for a burndown: one target's period as of `on` (categoryId null = the buffer) and its last " +
    "`past` (default 3) complete periods, or with categoryId omitted, the month's monthly targets together (multi-month " +
    "targets left out, as in the month's total) and the `past` months before. Each period: start, end, availableCents " +
    "(target with rollover and rebalancing) and its lines (date, signed amountCents), through `on` for the current one. " +
    "Null when the target isn't in effect on `on`. Net unless gross is true.",
  input: z.object({
    categoryId: targetCategory.optional(),
    on: isoDate.optional(),
    gross: z.boolean().default(false),
    past: z.number().int().min(0).max(6).default(3),
  }),
  run: async (db, { categoryId, on = today(), gross, past }) => {
    const versions = await loadVersions(db);
    if (!versions.length) return null;
    // Rollover carries from a target's first period, so the lines go back that far.
    const from = versions.reduce((min, v) => (v.effectiveFrom < min ? v.effectiveFrom : min), firstOfMonth(monthIndex(on) - 12 * 3));
    const [lines, { rows }, adjustments] = await Promise.all([
      spendingLines.run(db, { from, to: on, budgetOnly: true, gross }),
      labels(db),
      db.select({ categoryId: budgetAdjustments.categoryId, on: budgetAdjustments.on, amountCents: budgetAdjustments.amountCents }).from(budgetAdjustments),
    ]);
    const categories = rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind }));
    const spend = lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId }));
    const periods = periodsByKey({ on, versions, lines: spend, categories, adjustments });
    const linesOf = (key: string, start: string, end: string) =>
      linesForTarget({ key: key as typeof BUFFER, start, end: end < on ? end : on, versions, lines: spend, categories }).map((l) => ({ date: l.date, amountCents: l.amountCents }));

    if (categoryId !== undefined) {
      const key = keyOf(categoryId);
      const list = periods.get(key) ?? [];
      const current = list.find((p) => p.start <= on && on <= p.end);
      if (!current) return null;
      const period = (p: (typeof list)[number]) => ({ start: p.start, end: p.end, availableCents: p.availableCents, lines: linesOf(key, p.start, p.end) });
      return { ...period(current), past: list.filter((p) => p.end < current.start).slice(-past).reverse().map(period) };
    }

    // The month's monthly targets together, and the same for each month before.
    const month = (index: number) => {
      const start = firstOfMonth(index);
      let availableCents = 0;
      let targets = 0;
      const out: { date: string; amountCents: number }[] = [];
      for (const [key, list] of periods) {
        const p = list.find((x) => x.start === start && monthIndex(x.end) === index);
        if (!p) continue;
        targets++;
        availableCents += p.availableCents;
        out.push(...linesOf(key, p.start, p.end));
      }
      return targets ? { start, end: lastOfMonth(index), availableCents, lines: out } : null;
    };
    const current = month(monthIndex(on));
    if (!current) return null;
    const before = Array.from({ length: past }, (_, i) => month(monthIndex(on) - 1 - i)).filter((m): m is NonNullable<typeof m> => m !== null);
    return { ...current, past: before };
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

// --- Pay against the budget (#128, #138, #142) ---------------------------------
//
// The month view and the Year view count pay, targets and spending by the
// same rules, from these helpers, so the two can't drift apart.

async function loadPayInputs(db: Db, { from, to, gross }: { from: string; to: string; gross: boolean }) {
  const [stubs, versions, lines, deposits, { rows }] = await Promise.all([
    db.select({ payDate: payStubs.payDate, periodStart: payStubs.periodStart, periodEnd: payStubs.periodEnd, netCents: payStubs.netCents, oneTime: payStubs.oneTime }).from(payStubs),
    loadVersions(db),
    spendingLines.run(db, { from, to, budgetOnly: true, gross }),
    db.select({ transactionId: payStubDeposits.transactionId }).from(payStubDeposits),
    labels(db),
  ]);
  // Spending: expense lines only (transfers and pay never are). A linked
  // paycheck's deduction lines (health insurance under an expense
  // category, say) left the gross before net pay landed, so against net
  // pay they'd count twice.
  const expense = new Set(rows.filter((r) => r.kind === "expense").map((r) => r.id));
  const paycheck = new Set(deposits.map((d) => d.transactionId));
  const spending = lines.filter((l) => expense.has(l.categoryId) && !paycheck.has(l.transactionId));
  return { stubs, versions, spending };
}

// Each target in effect on `on` at its monthly share: a month's own target,
// or a twelfth of an annual one, so a month with an annual target isn't
// measured against the whole year's budget.
function monthlyTargetsCents(versions: TargetVersion[], on: string): number {
  const keys = [...new Set(versions.map((v) => v.categoryId))];
  return keys.reduce((sum, id) => {
    const v = currentVersion(versions, id, on);
    return v ? sum + Math.round(v.amountCents! / v.periodMonths) : sum;
  }, 0);
}

const spentBetween = (spending: { date: string; amountCents: number }[], from: string, to: string) =>
  -spending.filter((l) => l.date >= from && l.date <= to).reduce((sum, l) => sum + l.amountCents, 0);

export const budgetPay = defineRead({
  name: "budgets.pay",
  description:
    "The month's pay against its budget (as of `on`, default today), in cents and as a % of net pay. Net pay is a " +
    "typical month (`typical`: the recent regular paycheck times paychecks a year, over 12), so every month is measured " +
    "the same; `pay` is what landed (the month's pay stubs by pay date, plus in the current month paychecks still to " +
    "come at the recent pace), and landedDifferenceCents is that less the typical month. Total " +
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
    const [{ stubs, versions, spending }, uncategorized] = await Promise.all([
      loadPayInputs(db, { from, to: on, gross }),
      uncategorizedSpend.run(db, { from, to: on }),
    ]);
    const pay = payForMonth(month, now, stubs);
    // Measured against a typical month (#142), not the paychecks that
    // happened to land in this one: a third biweekly paycheck isn't a raise.
    // As of the month's end (or today), so the past keeps the pay it had.
    const typical = typicalMonth(stubs, on < now ? on : now);
    const basisCents = typical?.cents ?? pay.netPayCents;
    const targetsCents = monthlyTargetsCents(versions, on);
    const spentCents = spentBetween(spending, from, on);

    return {
      month,
      pay,
      typical,
      // What landed against the typical month: + extra (a third paycheck, a
      // bonus), − short. Null without both.
      landedDifferenceCents: typical && pay.netPayCents !== null ? pay.netPayCents - typical.cents : null,
      summary: basisCents === null ? null : paySummary({ netPayCents: basisCents, targetsCents, spentCents }),
      targetsCents,
      spentCents,
      // Money out not categorized yet isn't in spending; said so, not hidden.
      uncategorized,
    };
  },
});

export const budgetPayYear = defineRead({
  name: "budgets.payYear",
  description:
    "Pay against the budget over the Year view's months (the `months` ending with `on`'s, default 12): for each month " +
    "the net pay that landed (pay stubs by pay date, with this month's paychecks still to come at the recent pace), " +
    "total targets at their monthly share, spending, expected saving (pay less targets) and saved (pay less spending), " +
    "by the same rules as budgets.pay. The year adds up the months with pay; months without any are left out, and " +
    "counted. Unlike the month view this is actual pay, not a typical month, so the year is the sum of its months. " +
    "includeOneTime false leaves one-time stubs (bonuses) out. Spending is net unless gross is true.",
  allowedActors: ["user"],
  input: z.object({
    on: isoDate.optional(),
    gross: z.boolean().default(false),
    months: z.number().int().min(1).max(24).default(12),
    includeOneTime: z.boolean().default(true),
    today: isoDate.optional(),
  }),
  run: async (db, { on = today(), gross, months, includeOneTime, today: day }) => {
    const now = day ?? today();
    const end = monthIndex(on);
    const from = firstOfMonth(end - months + 1);
    const { stubs, versions, spending } = await loadPayInputs(db, { from, to: on, gross });
    const counted = includeOneTime ? stubs : stubs.filter((s) => !s.oneTime);
    type PayMonth = { month: string; payCents: number | null; targetsCents: number; spentCents: number; expectedSavingCents: number | null; savedCents: number | null };
    const rows: PayMonth[] = [];
    for (let m = end - months + 1; m <= end; m++) {
      const start = firstOfMonth(m);
      const monthOn = m === end ? on : lastOfMonth(m);
      const pay = payForMonth(start.slice(0, 7), now, counted).netPayCents;
      const targetsCents = monthlyTargetsCents(versions, monthOn);
      const spentCents = spentBetween(spending, start, monthOn);
      rows.push({
        month: start,
        payCents: pay,
        targetsCents,
        spentCents,
        expectedSavingCents: pay === null ? null : pay - targetsCents,
        savedCents: pay === null ? null : pay - spentCents,
      });
    }
    // The year: the months with pay, each counted in full, so it's always
    // the sum of the monthly figures shown under the grid.
    const withPay = rows.filter((r) => r.payCents !== null);
    const sum = (pick: (r: PayMonth) => number) => withPay.reduce((s, r) => s + pick(r), 0);
    const totals = { netPayCents: sum((r) => r.payCents!), targetsCents: sum((r) => r.targetsCents), spentCents: sum((r) => r.spentCents) };
    return {
      months: rows,
      monthsWithoutPay: rows.length - withPay.length,
      // One-time stubs (bonuses) paid in the window, and whether they're left out.
      oneTimeCount: stubs.filter((s) => s.oneTime && s.payDate >= from && s.payDate <= on).length,
      oneTimeLeftOut: !includeOneTime,
      totals,
      summary: withPay.length ? paySummary(totals) : null,
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
    "current period; earlier periods keep their old target. A target that runs over several months changes only " +
    "from its period's start, so a change that would start in a past month is refused: use backdating for that.",
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
    const versions = await loadVersions(ctx.db);
    const current = currentVersion(versions, input.categoryId, on);
    const effectiveFrom = changeEffectiveFrom(current, { periodMonths: input.periodMonths, anchorOn }, on);
    assertNotPast(effectiveFrom, on, "This target runs over several months, so a change starts at its period's start, which is a past month. Use backdating, which lists every month it changes first.");
    const version = {
      categoryId: input.categoryId,
      effectiveFrom,
      amountCents: input.amountCents,
      periodMonths: input.periodMonths,
      anchorOn,
      rollover: input.rollover,
      // A one-month period has nothing to set aside for.
      sinkingFund: input.sinkingFund && input.periodMonths > 1,
    };
    assertWholePeriod(versions, version);
    const row = await writeVersion(ctx, version);
    return { id: row.id, effectiveFrom };
  },
});

// --- Backdating a target (#130) -------------------------------------------------
//
// After backfilling a year of transactions, earlier months have spending
// and nothing to measure it against. A target can be given an earlier
// start, running until the target's next version, which keeps its amount.
// A month that already had a target can be changed the same way: the
// version starting that month is updated in place, and the review
// (backdatePreview, #137) lists each month's old and new amount before
// anything is saved (#150). The earliest it can start is the first month
// with transactions.

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
    "accounts (YYYY-MM, null with none), and this month, the latest a backdate can start.",
  input: z.object({ today: isoDate.optional() }),
  run: async (db, { today: day }) => ({ earliestMonth: await earliestMonth(db), currentMonth: (day ?? today()).slice(0, 7) }),
});

const backdateInput = z.object({
  categoryId: targetCategory,
  fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountCents: z.number().int().min(1).max(100_000_000_00),
  periodMonths: z.number().int().min(1).max(24).default(1),
  anchorMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  rollover: z.boolean().default(false),
  sinkingFund: z.boolean().default(false),
  today: isoDate.optional(),
});

// --- Whole periods (#166) ----------------------------------------------------
//
// A target that runs over several months is one budget for its whole period.
// A version that starts inside such a period cuts it short, and nothing
// restores the rest, so a change to a multi-month target starts at the start
// of a period: the one in force there, and the new version's own. Any start
// in a past month is a backdate, which lists every month it changes first.

const monthName = (index: number) =>
  new Date(Date.UTC(Math.floor(index / 12), index % 12, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

/** A change made now starts in this month or later; past starts go through backdating. */
function assertNotPast(effectiveFrom: string, on: string, message: string) {
  if (effectiveFrom < `${on.slice(0, 7)}-01`) throw new Error(message);
}

/** Refuses a version that would start inside a multi-month period, of the version in force then or of its own. */
function assertWholePeriod(versions: TargetVersion[], version: TargetVersion) {
  const start = monthIndex(version.effectiveFrom);
  const inForce = currentVersion(versions, version.categoryId, version.effectiveFrom);
  for (const v of [inForce, version]) {
    if (!v || v.amountCents === null || v.periodMonths === 1) continue;
    const period = naturalPeriod(start, v.periodMonths, v.anchorOn);
    if (period.start === start) continue;
    throw new Error(
      `This target runs ${monthName(period.start)} to ${monthName(period.end)} as one budget, so a change starts at ${monthName(period.start)}. ` +
        "Use backdating for that, which lists every month it changes first.",
    );
  }
}

/**
 * The version a backdate would write, after the same checks the write
 * makes, shared by its preview (#137) so the warning can never list a
 * backdate the save would refuse. Throws with the reason otherwise.
 */
async function plannedBackdate(db: Db, input: z.infer<typeof backdateInput>) {
  const on = input.today ?? today();
  if (input.fromMonth > on.slice(0, 7)) throw new Error("A target can't start after this month");
  const first = await earliestMonth(db);
  if (!first || input.fromMonth < first) throw new Error(`The earliest a target can start is ${first ?? "the first month with transactions"}`);
  const effectiveFrom = `${input.fromMonth}-01`;
  const versions = await loadVersions(db);
  const own = versions.filter((v) => v.categoryId === input.categoryId);
  const anchorOn = input.anchorMonth ? `${input.anchorMonth}-01` : input.periodMonths === 12 ? `${input.fromMonth.slice(0, 4)}-01-01` : effectiveFrom;
  const next = own.filter((v) => v.effectiveFrom > effectiveFrom).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const version: TargetVersion = {
    categoryId: input.categoryId,
    effectiveFrom,
    amountCents: input.amountCents,
    periodMonths: input.periodMonths,
    anchorOn,
    rollover: input.rollover,
    // A one-month period has nothing to set aside for.
    sinkingFund: input.sinkingFund && input.periodMonths > 1,
  };
  assertWholePeriod(versions, version);
  return { on, version, versions, until: next ? next.effectiveFrom : null };
}

export const backdateTarget = defineWrite({
  name: "budgets.backdateTarget",
  description:
    "Give a target (categoryId null = the buffer) an earlier start: amountCents per period from fromMonth (YYYY-MM), " +
    "running until the target's next version, which keeps its amount. A month that already had a target is changed " +
    "too: a version starting that month is updated in place. Never earlier than the first month with transactions, " +
    "and not after this month (budgets.setTarget " +
    "covers changes from the current period's start). periodMonths, anchorMonth (default January for annual, else fromMonth), rollover and " +
    "sinkingFund as in budgets.setTarget. With rollover, what later periods have available changes. " +
    "budgets.backdatePreview lists the months it changes first.",
  input: backdateInput,
  apply: async (ctx, input) => {
    await assertExpenseCategory(ctx, input.categoryId);
    const { version, until } = await plannedBackdate(ctx.db, input);
    const row = await writeVersion(ctx, version);
    // Until the next version, or open-ended when there's none (it becomes the current target).
    return { id: row.id, effectiveFrom: version.effectiveFrom, until };
  },
});

export const backdatePreview = defineRead({
  name: "budgets.backdatePreview",
  description:
    "What budgets.backdateTarget would change, without changing anything (#137): each month from fromMonth until the " +
    "target's next version (or this month), with the target that month had before (null: none) and would have after, " +
    "as budgets.status reports it, with the period it belongs to. Refuses what backdateTarget would refuse.",
  input: backdateInput,
  run: async (db, input) => {
    const { on, version, versions, until } = await plannedBackdate(db, input);
    const key = input.categoryId;
    // Each month's target as the engine works it out, now and with the new
    // version in place: the same figures the page shows for those months.
    const targetIn = (all: TargetVersion[], month: number) => {
      const s = computeStatus({ on: lastOfMonth(month), versions: all, lines: [], categories: [], adjustments: [] });
      const t = s.targets.find((x) => x.key === (key ?? BUFFER));
      return t ? { targetCents: t.targetCents, periodMonths: t.periodMonths, start: t.start, end: t.end } : null;
    };
    const last = until ? monthIndex(until) - 1 : monthIndex(on);
    const months = [];
    for (let m = monthIndex(version.effectiveFrom); m <= last; m++) {
      months.push({ month: firstOfMonth(m).slice(0, 7), before: targetIn(versions, m), after: targetIn([...versions, version], m) });
    }
    return { months, until, rollover: version.rollover };
  },
});

// --- Deleting one term or month (#181) ------------------------------------------
//
// A target is a list of versions, and each one covers the months from its
// start until the next one. Deleting a version gives its months back to the
// version before it, and leaves every later version as it was. A whole
// target is only ended once no versions are left.

const deleteInput = z.object({
  categoryId: targetCategory,
  fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  today: isoDate.optional(),
});

/** The version starting `fromMonth`, the versions without it, and where it stops; refuses what the delete would cut short. */
async function plannedDelete(db: Db, input: z.infer<typeof deleteInput>) {
  const on = input.today ?? today();
  const effectiveFrom = `${input.fromMonth}-01`;
  const versions = await loadVersions(db);
  const own = versions.filter((v) => v.categoryId === input.categoryId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const version = own.find((v) => v.effectiveFrom === effectiveFrom);
  if (!version) throw new Error("There's no target starting that month");
  const previous = own.filter((v) => v.effectiveFrom < effectiveFrom).at(-1) ?? null;
  const next = own.find((v) => v.effectiveFrom > effectiveFrom) ?? null;
  // The version before is still in force up to the next one, so the next
  // one can't start inside one of its multi-month periods.
  if (previous && next && previous.amountCents !== null && previous.periodMonths > 1) {
    const start = monthIndex(next.effectiveFrom);
    const period = naturalPeriod(start, previous.periodMonths, previous.anchorOn);
    if (period.start !== start) {
      throw new Error(
        `Deleting this would cut the target before it short: it runs ${monthName(period.start)} to ${monthName(period.end)} as one budget.`,
      );
    }
  }
  return { on, version, versions, without: versions.filter((v) => v !== version), until: next ? next.effectiveFrom : null };
}

export const deleteVersionPreview = defineRead({
  name: "budgets.deleteVersionPreview",
  description:
    "What budgets.deleteVersion would change, without changing anything (#181): each month the version covered, from its " +
    "start until the next version (or this month), with the target that month had before and the one it falls back to " +
    "(null: none). Refuses what deleteVersion would refuse.",
  input: deleteInput,
  run: async (db, input) => {
    const { on, version, versions, without, until } = await plannedDelete(db, input);
    const key = input.categoryId;
    const targetIn = (all: TargetVersion[], month: number) => {
      const s = computeStatus({ on: lastOfMonth(month), versions: all, lines: [], categories: [], adjustments: [] });
      const t = s.targets.find((x) => x.key === (key ?? BUFFER));
      return t ? { targetCents: t.targetCents, periodMonths: t.periodMonths, start: t.start, end: t.end } : null;
    };
    const last = until ? monthIndex(until) - 1 : monthIndex(on);
    const months = [];
    for (let m = monthIndex(version.effectiveFrom); m <= last; m++) {
      months.push({ month: firstOfMonth(m).slice(0, 7), before: targetIn(versions, m), after: targetIn(without, m) });
    }
    return { months, until };
  },
});

export const deleteVersion = defineWrite({
  name: "budgets.deleteVersion",
  description:
    "Delete one version of a target (categoryId null = the buffer), starting fromMonth (YYYY-MM): its months fall back to " +
    "the target in force before it, and later versions keep their amounts. budgets.deleteVersionPreview lists the months " +
    "it changes first. Refused when there's no version starting that month, or when the version before would be cut short.",
  input: deleteInput,
  apply: async (ctx, input) => {
    await assertExpenseCategory(ctx, input.categoryId);
    const { version } = await plannedDelete(ctx.db, input);
    const [row] = await ctx.db
      .select({ id: budgetTargets.id })
      .from(budgetTargets)
      .where(
        and(
          input.categoryId ? eq(budgetTargets.categoryId, input.categoryId) : isNull(budgetTargets.categoryId),
          eq(budgetTargets.effectiveFrom, version.effectiveFrom),
        ),
      );
    await ctx.remove(budgetTargets, row.id);
    return { effectiveFrom: version.effectiveFrom };
  },
});

export const removeTarget = defineWrite({
  name: "budgets.removeTarget",
  description:
    "End a budget target from the start of its current period (categoryId null = the buffer). Its history " +
    "stays; its category's spending falls to the buffer from then on. A target that runs over several months " +
    "can't be ended from a past month yet.",
  input: z.object({ categoryId: targetCategory, today: isoDate.optional() }),
  apply: async (ctx, { categoryId, today: day }) => {
    const on = day ?? today();
    const current = currentVersion(await loadVersions(ctx.db), categoryId, on);
    if (!current) throw new Error("There's no target to remove");
    const effectiveFrom = changeEffectiveFrom(current, current, on);
    assertNotPast(effectiveFrom, on, "Ending this target would change a past month, since it runs over several months. Ending it from a past month isn't supported yet.");
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
