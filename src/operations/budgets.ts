import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { budgetAdjustments, budgetTargets, categories } from "@/db/schema";
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
  type TargetVersion,
} from "@/lib/budgets/engine";
import { categoryOptions } from "@/lib/categorize/labels";
import { defineRead, defineWrite } from "@/operations/define";
import { spendingLines } from "@/operations/transactions";
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
    "lists what drew from it this period by category. Net of shared expenses (your share counts) unless " +
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
