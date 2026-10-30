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
