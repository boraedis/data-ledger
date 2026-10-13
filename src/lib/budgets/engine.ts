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

/** Days from `start` to `end`, inclusive. */
function days(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
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

    const elapsedShare = Math.min(1, days(current.start, on) / days(current.start, current.end));
    const months = monthIndex(current.end) - monthIndex(current.start) + 1;
    const monthsStarted = monthIndex(on) - monthIndex(current.start) + 1;
    const multiMonth = months > 1;
    const setAsideMonthly = current.sinkingFund && multiMonth ? Math.round(current.targetCents / months) : null;
    targets.push({
      ...current,
      elapsedShare,
      paceCents: multiMonth ? Math.round(current.availableCents * elapsedShare) : null,
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
