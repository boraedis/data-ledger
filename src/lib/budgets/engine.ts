// The budget engine (#7): pure functions over targets, spending lines and
// adjustments. No database here, so every rule below is unit-tested
// directly (engine.test.ts). The budgets.* operations load the data and
// call in.
//
// The model, in brief:
// - A target belongs to a category, or to the **buffer** (categoryId null),
//   which every expense category without a target of its own draws from.
//   A target on a parent covers its children unless a child has its own.
// - Periods are N months long, counted from an anchor month: 1 is monthly,
//   12 annual, anything else custom. Every boundary is the first of a month.
// - Targets are **versioned**. A version applies from its effectiveFrom
//   until the next version's. Changing a target adds a version starting at
//   the current period's start, so earlier periods keep the target they had.
//   If the new version's schedule doesn't start there (monthly → annual in
//   October), its first period is clipped to start at effectiveFrom and its
//   target prorated by months, so no spending is counted twice.
// - **Rollover** carries a period's remaining amount (negative when
//   overspent) into the next, while consecutive versions keep rollover on.
// - **Net spend**: −(sum of signed amounts), so a refund in a category
//   offsets its spending. Only expense-kind categories count; income and
//   transfer categories, uncategorized lines and matched transfers never
//   reach a budget. Shared expenses arrive here already net of what
//   friends owe (#8, in transactions.spendingLines).

import { elapsedShare, evenPace } from "@/lib/pace";

export const BUFFER = "buffer" as const;
export type TargetKey = string; // a category id, or BUFFER

export type TargetVersion = {
  categoryId: string | null;
  effectiveFrom: string; // YYYY-MM-01
  amountCents: number | null;
  periodMonths: number;
  anchorOn: string; // YYYY-MM-01
  rollover: boolean;
  sinkingFund: boolean;
};

export type SpendLine = { date: string; amountCents: number; categoryId: string };
export type CategoryInfo = { id: string; parentId: string | null; kind: "expense" | "income" | "transfer" };
export type Adjustment = { categoryId: string | null; on: string; amountCents: number };

export const keyOf = (categoryId: string | null): TargetKey => categoryId ?? BUFFER;

// --- Months -----------------------------------------------------------------

/** "2026-10-13" → months since year 0 (2026 * 12 + 9). */
export function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

export function firstOfMonth(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export function lastOfMonth(index: number): string {
  const year = Math.floor(index / 12);
  const month = index % 12; // 0-based
  const day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${firstOfMonth(index).slice(0, 8)}${String(day).padStart(2, "0")}`;
}

/** The natural period (by schedule alone) containing month `index`, as month indexes. */
export function naturalPeriod(index: number, periodMonths: number, anchorOn: string): { start: number; end: number } {
  const anchor = monthIndex(anchorOn);
  const k = Math.floor((index - anchor) / periodMonths);
  const start = anchor + k * periodMonths;
  return { start, end: start + periodMonths - 1 };
}

// --- Versions ---------------------------------------------------------------

function versionsByKey(versions: TargetVersion[]): Map<TargetKey, TargetVersion[]> {
  const byKey = new Map<TargetKey, TargetVersion[]>();
  for (const v of versions) byKey.set(keyOf(v.categoryId), [...(byKey.get(keyOf(v.categoryId)) ?? []), v]);
  for (const list of byKey.values()) list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return byKey;
}

/** The version in effect on `date` (null if none, or if the target was ended). */
function versionAt(list: TargetVersion[] | undefined, date: string): TargetVersion | null {
  let found: TargetVersion | null = null;
  for (const v of list ?? []) if (v.effectiveFrom <= date) found = v;
  return found && found.amountCents !== null ? found : null;
}

/**
 * Where a change made on `today` takes effect: the start of the current
 * period under the version in effect now, or — for a new target — the
 * start of its own schedule's period containing today (so a new annual
 * target covers the whole year to date).
 */
export function changeEffectiveFrom(
  current: TargetVersion | null,
  next: { periodMonths: number; anchorOn: string },
  today: string,
): string {
  const settings = current ?? next;
  return firstOfMonth(naturalPeriod(monthIndex(today), settings.periodMonths, settings.anchorOn).start);
}

export function currentVersion(versions: TargetVersion[], categoryId: string | null, today: string): TargetVersion | null {
  return versionAt(versionsByKey(versions).get(keyOf(categoryId)), today);
}

// --- Which target a line counts toward ---------------------------------------

/**
 * The target a spending line counts toward on its date: its own
 * category's, else its parent's, else the buffer. Null for lines that
 * aren't spending (income and transfer categories).
 */
export function targetKeyFor(
  line: SpendLine,
  categories: Map<string, CategoryInfo>,
  byKey: Map<TargetKey, TargetVersion[]>,
): TargetKey | null {
  const category = categories.get(line.categoryId);
  if (!category || category.kind !== "expense") return null;
  if (versionAt(byKey.get(category.id), line.date)) return category.id;
  if (category.parentId && versionAt(byKey.get(category.parentId), line.date)) return category.parentId;
  return BUFFER;
}

// --- Periods and status -------------------------------------------------------

export type PeriodStatus = {
  key: TargetKey;
  start: string;
  end: string;
  periodMonths: number;
  // This period's target, prorated if the period was clipped.
  targetCents: number;
  carryInCents: number;
  adjustmentsCents: number;
  availableCents: number;
  spentCents: number;
  remainingCents: number;
  rollover: boolean;
  sinkingFund: boolean;
  // The version in effect: when it started, its per-period amount and
  // schedule anchor (what an edit starts from).
  effectiveFrom: string;
  amountCents: number;
  anchorOn: string;
};

/**
 * Every period of one target from its first version through the period
 * containing `through`, with rollover carried along. Gaps (a target ended
 * and later restarted) reset the carry.
 */
export function periodsFor(
  list: TargetVersion[],
  spentIn: (start: string, end: string) => number,
  adjustedIn: (start: string, end: string) => number,
  through: string,
): PeriodStatus[] {
  const periods: PeriodStatus[] = [];
  const throughIndex = monthIndex(through);
  let carry = 0;
  let previousEndIndex: number | null = null;
  let previousRollover = false;

  list.forEach((v, i) => {
    if (v.amountCents === null) return;
    const nextFrom = list[i + 1]?.effectiveFrom;
    const stopIndex = nextFrom ? monthIndex(nextFrom) : Infinity; // first month NOT covered
    let cursor = monthIndex(v.effectiveFrom);
    while (cursor <= throughIndex && cursor < stopIndex) {
      const natural = naturalPeriod(cursor, v.periodMonths, v.anchorOn);
      const startIndex = Math.max(natural.start, cursor);
      const endIndex = Math.min(natural.end, stopIndex - 1);
      const months = endIndex - startIndex + 1;
      const targetCents = Math.round((v.amountCents * months) / v.periodMonths);
      const start = firstOfMonth(startIndex);
      const end = lastOfMonth(endIndex);

      const contiguous = previousEndIndex !== null && previousEndIndex + 1 === startIndex;
      const carryInCents = contiguous && previousRollover && v.rollover ? carry : 0;
      const adjustmentsCents = adjustedIn(start, end);
      const spentCents = spentIn(start, end);
      const availableCents = targetCents + carryInCents + adjustmentsCents;
      const remainingCents = availableCents - spentCents;
      periods.push({
        key: keyOf(v.categoryId),
        start,
        end,
        periodMonths: v.periodMonths,
        targetCents,
        carryInCents,
        adjustmentsCents,
        availableCents,
        spentCents,
        remainingCents,
        rollover: v.rollover,
        sinkingFund: v.sinkingFund,
        effectiveFrom: v.effectiveFrom,
        amountCents: v.amountCents,
        anchorOn: v.anchorOn,
      });
      carry = remainingCents;
      previousEndIndex = endIndex;
      previousRollover = v.rollover;
      cursor = endIndex + 1;
    }
  });
  return periods;
}


export type TargetStatus = PeriodStatus & {
  // Share of the period elapsed on the status date, 0–1.
  elapsedShare: number;
  // Spend you'd expect by now at an even pace (multi-month periods).
  paceCents: number | null;
  // Sinking fund: what to set aside each month, and what should be set aside by now.
  setAsideMonthlyCents: number | null;
  setAsideByNowCents: number | null;
};

export type BudgetStatus = {
  on: string;
  targets: TargetStatus[];
  // What drew from the buffer in its current period (or this calendar month
  // when there's no buffer target), by category — where a new category or
  // target might be worth creating.
  unbudgeted: { start: string; end: string; byCategory: { categoryId: string; spentCents: number }[] };
};

export function budgetStatus(input: {
  on: string;
  versions: TargetVersion[];
  lines: SpendLine[];
  categories: CategoryInfo[];
  adjustments: Adjustment[];
}): BudgetStatus {
  const { on } = input;
  const byKey = versionsByKey(input.versions);
  const categories = new Map(input.categories.map((c) => [c.id, c]));

  // Resolve every line once: which target it counts toward on its own date.
  const resolved = input.lines
    .map((line) => ({ line, key: targetKeyFor(line, categories, byKey) }))
    .filter((r): r is { line: SpendLine; key: TargetKey } => r.key !== null);
  const linesFor = new Map<TargetKey, SpendLine[]>();
  for (const { line, key } of resolved) linesFor.set(key, [...(linesFor.get(key) ?? []), line]);

  const targets: TargetStatus[] = [];
  for (const [key, list] of byKey) {
    if (!versionAt(list, on)) continue;
    const lines = linesFor.get(key) ?? [];
    const adjustments = input.adjustments.filter((a) => keyOf(a.categoryId) === key);
    const periods = periodsFor(
      list,
      (start, end) => -lines.filter((l) => l.date >= start && l.date <= end).reduce((sum, l) => sum + l.amountCents, 0),
      (start, end) => adjustments.filter((a) => a.on >= start && a.on <= end).reduce((sum, a) => sum + a.amountCents, 0),
      on,
    );
    const current = periods.find((p) => p.start <= on && on <= p.end);
    if (!current) continue;

    const elapsed = elapsedShare(current.start, current.end, on);
    const months = monthIndex(current.end) - monthIndex(current.start) + 1;
    const monthsStarted = monthIndex(on) - monthIndex(current.start) + 1;
    const multiMonth = months > 1;
    const setAsideMonthly = current.sinkingFund && multiMonth ? Math.round(current.targetCents / months) : null;
    targets.push({
      ...current,
      elapsedShare: elapsed,
      paceCents: multiMonth ? evenPace(0, current.availableCents, elapsed) : null,
      setAsideMonthlyCents: setAsideMonthly,
      setAsideByNowCents: setAsideMonthly === null ? null : Math.min(current.targetCents, setAsideMonthly * monthsStarted),
    });
  }

  // The buffer's current period, or the calendar month without one.
  const buffer = targets.find((t) => t.key === BUFFER);
  const start = buffer?.start ?? firstOfMonth(monthIndex(on));
  const end = buffer?.end ?? lastOfMonth(monthIndex(on));
  const byCategory = new Map<string, number>();
  for (const line of linesFor.get(BUFFER) ?? []) {
    if (line.date < start || line.date > end) continue;
    byCategory.set(line.categoryId, (byCategory.get(line.categoryId) ?? 0) - line.amountCents);
  }

  // Buffer first, then the most-used share of each target.
  targets.sort((a, b) =>
    a.key === BUFFER ? -1 : b.key === BUFFER ? 1 : b.spentCents / (b.availableCents || 1) - a.spentCents / (a.availableCents || 1),
  );
  return {
    on,
    targets,
    unbudgeted: {
      start,
      end,
      byCategory: [...byCategory]
        .map(([categoryId, spentCents]) => ({ categoryId, spentCents }))
        .filter((c) => c.spentCents !== 0)
        .sort((a, b) => b.spentCents - a.spentCents),
    },
  };
}

// --- Recent history (#105) ------------------------------------------------------

// Full months looked back over, the current partial month left out. Three
// is enough to see what a category usually costs without a year-old habit
// dragging on it; a setting can come later if it proves too short.
export const HISTORY_MONTHS = 3;

export type CategoryHistory = {
  key: TargetKey;
  // Each month's net spend, oldest first, from the first month with any.
  months: { month: string; spentCents: number }[];
  // Average over those months; null when there's no spend in the window at all.
  averageCents: number | null;
  // Monthly targets only: how many of those months went over today's target
  // (would this target have held?), out of how many.
  overMonths: number | null;
  comparedMonths: number;
};

/**
 * What each expense category (and the buffer) cost in each of the last
 * `months` full months before `on`. A category covers what a target on it
 * would cover today: its own lines and those of its children without a
 * target of their own, so a category with no target yet gets the same
 * figure as one with. The buffer covers what draws from it today. A
 * category first seen inside the window is averaged from that month on, so
 * a new one isn't diluted by months before it existed; one with nothing in
 * the window has no history rather than $0.
 */
export function recentHistory(input: {
  on: string;
  versions: TargetVersion[];
  lines: SpendLine[];
  categories: CategoryInfo[];
  months?: number;
}): Map<TargetKey, CategoryHistory> {
  const months = input.months ?? HISTORY_MONTHS;
  const end = monthIndex(input.on) - 1;
  const start = end - months + 1;
  const byKey = versionsByKey(input.versions);
  const categories = new Map(input.categories.map((c) => [c.id, c]));
  const hasOwn = (id: string) => Boolean(versionAt(byKey.get(id), input.on));

  // Every key a line counts toward: its category, its parent when the line's
  // category has no target of its own, and the buffer when that's where it
  // draws from today.
  const spent = new Map<TargetKey, number[]>();
  const add = (key: TargetKey, index: number, cents: number) => {
    const row = spent.get(key) ?? new Array<number>(months).fill(0);
    row[index] += cents;
    spent.set(key, row);
  };
  const seen = new Map<TargetKey, number>();
  const note = (key: TargetKey, index: number) => seen.set(key, Math.min(seen.get(key) ?? Infinity, index));
  for (const line of input.lines) {
    const m = monthIndex(line.date);
    if (m < start || m > end) continue;
    const category = categories.get(line.categoryId);
    if (!category || category.kind !== "expense") continue;
    const i = m - start;
    const keys = [category.id];
    if (category.parentId && !hasOwn(category.id)) keys.push(category.parentId);
    if (targetKeyFor({ ...line, date: input.on }, categories, byKey) === BUFFER) keys.push(BUFFER);
    for (const key of keys) {
      add(key, i, -line.amountCents);
      note(key, i);
    }
  }

  const result = new Map<TargetKey, CategoryHistory>();
  const keys = [BUFFER, ...input.categories.filter((c) => c.kind === "expense").map((c) => c.id)];
  for (const key of keys) {
    const first = seen.get(key);
    const row = spent.get(key);
    const list = first === undefined || !row ? [] : row.slice(first).map((spentCents, j) => ({ month: firstOfMonth(start + first + j), spentCents }));
    const total = list.reduce((s, m) => s + m.spentCents, 0);

    let overMonths: number | null = null;
    let comparedMonths = 0;
    const current = versionAt(byKey.get(key), input.on);
    // Against today's target, not the one each month had: a target set this
    // month would otherwise have nothing to compare with until next quarter.
    if (current && current.periodMonths === 1) {
      overMonths = list.filter((m) => m.spentCents > current.amountCents!).length;
      comparedMonths = list.length;
    }
    result.set(key, { key, months: list, averageCents: list.length ? Math.round(total / list.length) : null, overMonths, comparedMonths });
  }
  return result;
}

// --- Monthly series (#107) ------------------------------------------------------

// Months on each budget card's chart: the month shown and the ones before.
// Six shows creep and a seasonal spike without crowding a phone-width card.
export const SERIES_MONTHS = 6;

export type MonthBar = {
  month: string; // first of the month
  spentCents: number;
  // The target's monthly amount in effect that month (a multi-month
  // target's even monthly share); null before the target existed.
  targetCents: number | null;
};

/**
 * Each current target's net spend in each of the last `months` months up to
 * and including `on`'s (which is partial when `on` is today). Where the
 * target was in effect, a month counts exactly what budgets.status counted
 * toward it (lines resolved on their own dates). Before it existed, a month
 * counts what the target would cover today, as recentHistory does, so the
 * trend leading up to a new target is there to see rather than empty. Every
 * month is listed, with $0 where nothing was spent. (An ended target covers
 * nothing today, so its months without a target read $0.)
 *
 * The reference amount is the target itself, not what was available: rollover
 * and rebalancing change what a period can spend, not what it was meant to.
 */
export function monthlySeries(input: {
  on: string;
  versions: TargetVersion[];
  lines: SpendLine[];
  categories: CategoryInfo[];
  months?: number;
  // Also targets in effect at some point in the window but not on `on`
  // (#108's grid, where a past month shows the target it had).
  includeEnded?: boolean;
}): Map<TargetKey, MonthBar[]> {
  const months = input.months ?? SERIES_MONTHS;
  const end = monthIndex(input.on);
  const start = end - months + 1;
  const byKey = versionsByKey(input.versions);
  const categories = new Map(input.categories.map((c) => [c.id, c]));

  const result = new Map<TargetKey, MonthBar[]>();
  for (const [key, list] of byKey) {
    const bars: MonthBar[] = [];
    for (let m = start; m <= end; m++) {
      const v = versionAt(list, firstOfMonth(m));
      bars.push({ month: firstOfMonth(m), spentCents: 0, targetCents: v ? Math.round(v.amountCents! / v.periodMonths) : null });
    }
    const current = Boolean(versionAt(list, input.on));
    if (current || (input.includeEnded && bars.some((b) => b.targetCents !== null))) result.set(key, bars);
  }

  for (const line of input.lines) {
    const m = monthIndex(line.date);
    if (m < start || m > end || line.date > input.on) continue;
    const onItsDate = targetKeyFor(line, categories, byKey);
    if (onItsDate === null) continue;
    const today = targetKeyFor({ ...line, date: input.on }, categories, byKey);
    for (const [key, bars] of result) {
      const bar = bars[m - start];
      // In effect then: what status counted. Not yet: what it would cover now.
      if ((bar.targetCents !== null ? onItsDate : today) === key) bar.spentCents -= line.amountCents;
    }
  }
  return result;
}

// --- A calendar year across all targets (#123) -----------------------------------

export type YearTarget = {
  key: TargetKey;
  // The year's share of each period's target and spending, summed.
  targetCents: number;
  spentCents: number;
  // Periods that touch the year, whole or in part.
  periods: number;
};

/**
 * Every target's calendar year: the target and net spending of each of its
 * periods that falls in the year, at the version each period had, so a
 * target changed mid-year counts each period at its own amount and one that
 * has ended still counts for the periods it covered. Later periods of the
 * current year count in full (the year's budget, not just what's elapsed);
 * their spending is whatever there is so far.
 *
 * A period that straddles the year (an annual target starting in April)
 * contributes the year's months of its target, pro rata, and the spending
 * dated in the year. The target is the target, not what rollover or
 * rebalancing made available: rebalancing moves money between targets and
 * sums to nothing across them anyway. Each line counts toward exactly one
 * target, so the targets add up without counting anything twice.
 */
export function yearSummary(input: { year: number; versions: TargetVersion[]; lines: SpendLine[]; categories: CategoryInfo[] }): YearTarget[] {
  const yearStart = `${input.year}-01-01`;
  const yearEnd = `${input.year}-12-31`;
  const byKey = versionsByKey(input.versions);
  const categories = new Map(input.categories.map((c) => [c.id, c]));
  const linesFor = new Map<TargetKey, SpendLine[]>();
  for (const line of input.lines) {
    const key = targetKeyFor(line, categories, byKey);
    if (key !== null) linesFor.set(key, [...(linesFor.get(key) ?? []), line]);
  }

  const result: YearTarget[] = [];
  for (const [key, list] of byKey) {
    const lines = linesFor.get(key) ?? [];
    const spentIn = (start: string, end: string) => -lines.filter((l) => l.date >= start && l.date <= end).reduce((sum, l) => sum + l.amountCents, 0);
    let targetCents = 0;
    let spentCents = 0;
    let periods = 0;
    for (const p of periodsFor(list, spentIn, () => 0, yearEnd)) {
      if (p.end < yearStart || p.start > yearEnd) continue;
      const months = monthIndex(p.end) - monthIndex(p.start) + 1;
      const from = p.start < yearStart ? yearStart : p.start;
      const to = p.end > yearEnd ? yearEnd : p.end;
      const inYear = monthIndex(to) - monthIndex(from) + 1;
      targetCents += inYear === months ? p.targetCents : Math.round((p.targetCents * inYear) / months);
      spentCents += spentIn(from, to);
      periods++;
    }
    if (periods) result.push({ key, targetCents, spentCents, periods });
  }
  return result;
}
