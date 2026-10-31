// The Targets page's list (#145): every target there has been, from its
// version history, split into those in effect today and those ended. The
// buffer comes first, then by name, as on the Year view.

type Version = {
  categoryId: string | null;
  name: string;
  effectiveFrom: string;
  amountCents: number | null;
  periodMonths: number;
  rollover: boolean;
  sinkingFund: boolean;
};

export type ActiveTarget = {
  categoryId: string | null;
  name: string;
  amountCents: number;
  periodMonths: number;
  rollover: boolean;
  sinkingFund: boolean;
  /** When the amount in effect now started. */
  since: string;
  /** Versions after the first: how many times it has been changed. */
  changes: number;
};

export type EndedTarget = { categoryId: string | null; name: string; endedOn: string; lastAmountCents: number | null };

export function targetList(versions: Version[], today: string): { active: ActiveTarget[]; ended: EndedTarget[] } {
  const byKey = new Map<string, Version[]>();
  for (const v of versions) byKey.set(v.categoryId ?? "", [...(byKey.get(v.categoryId ?? "") ?? []), v]);

  const active: ActiveTarget[] = [];
  const ended: EndedTarget[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    // Only versions already started: a backdated change is in the past by
    // definition, and nothing else writes a future one.
    const started = list.filter((v) => v.effectiveFrom <= today);
    const now = started.at(-1);
    if (!now) continue;
    if (now.amountCents === null) {
      const before = started.at(-2);
      ended.push({ categoryId: now.categoryId, name: now.name, endedOn: now.effectiveFrom, lastAmountCents: before?.amountCents ?? null });
    } else {
      active.push({
        categoryId: now.categoryId,
        name: now.name,
        amountCents: now.amountCents,
        periodMonths: now.periodMonths,
        rollover: now.rollover,
        sinkingFund: now.sinkingFund,
        since: now.effectiveFrom,
        changes: started.length - 1,
      });
    }
  }
  const order = (a: { categoryId: string | null; name: string }, b: { categoryId: string | null; name: string }) =>
    a.categoryId === null ? -1 : b.categoryId === null ? 1 : a.name.localeCompare(b.name);
  return { active: active.sort(order), ended: ended.sort(order) };
}

export type VersionSpan = {
  effectiveFrom: string;
  /** The last month this version applied (first of month); null while it still does. */
  until: string | null;
  /** Null: the target ended from effectiveFrom. */
  amountCents: number | null;
  periodMonths: number;
  anchorOn: string;
  rollover: boolean;
  sinkingFund: boolean;
};

/**
 * One target's versions as a list (#174), oldest first, each with the
 * months it covered: until the month before the next version starts.
 */
export function versionSpans(versions: (Omit<VersionSpan, "until"> & { categoryId: string | null })[], categoryId: string | null): VersionSpan[] {
  const own = versions.filter((v) => v.categoryId === categoryId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return own.map((v, i) => {
    const next = own[i + 1];
    let until: string | null = null;
    if (next) {
      const d = new Date(`${next.effectiveFrom.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      until = d.toISOString().slice(0, 10);
    }
    return {
      effectiveFrom: v.effectiveFrom,
      until,
      amountCents: v.amountCents,
      periodMonths: v.periodMonths,
      anchorOn: v.anchorOn,
      rollover: v.rollover,
      sinkingFund: v.sinkingFund,
    };
  });
}

const monthNumber = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthText = (n: number) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;

/**
 * The month a past version is changed from (#174), YYYY-MM, or null when it
 * can't be. Its own start, unless that's before the first month with
 * transactions, which is as far back as budgets.backdateTarget goes; then
 * the first of its periods starting from that month, since a multi-month
 * target changes only from a period's start (#166). Null with no
 * transactions, or when that month is past the version's end or this month.
 */
export function versionEditFrom(v: Pick<VersionSpan, "effectiveFrom" | "until" | "anchorOn" | "periodMonths">, earliestMonth: string | null, currentMonth: string): string | null {
  if (earliestMonth === null) return null;
  let from = v.effectiveFrom.slice(0, 7);
  if (from < earliestMonth) {
    const behind = (((monthNumber(earliestMonth) - monthNumber(v.anchorOn)) % v.periodMonths) + v.periodMonths) % v.periodMonths;
    from = monthText(monthNumber(earliestMonth) + (behind === 0 ? 0 : v.periodMonths - behind));
  }
  if (from > currentMonth || (v.until !== null && from > v.until.slice(0, 7))) return null;
  return from;
}
