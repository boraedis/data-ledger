// Matching provisional transactions to their synced versions (#30). Pure,
// so the rules are tested without a database; src/operations/provisional.ts
// applies them.
//
// A provisional transaction comes from a purchase alert, usually the same
// minute as the purchase. The bank reports it a day or a few later, under
// its own description, so matching can't use the text. It uses what both
// sides agree on: the account, the exact amount, and a short window after
// the purchase. A tip or a currency conversion changes the amount, and
// such a purchase is left for the owner to match by hand (the review list
// offers the likely candidates) rather than guessed at.

// The bank's date can be a day earlier (time zones: an evening purchase
// alerted in local time, posted in the bank's) and is usually a few days
// later, when the charge settles.
export const DAYS_BEFORE = 1;
export const DAYS_AFTER = 5;

// An alert with no synced version after this long probably never posted:
// a declined or reversed charge, or an alert parsed wrong. The owner
// decides.
export const STALE_DAYS = 7;

export type ProvisionalRow = { id: string; accountId: string; amountCents: number; postedOn: string; createdAt: Date };
export type SyncedRow = { id: string; accountId: string; amountCents: number; postedOn: string; createdAt: Date };

const DAY_MS = 86_400_000;
export const dayOffset = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * Pairs each provisional transaction with at most one synced transaction,
 * and each synced transaction with at most one provisional. Only synced
 * rows that arrived after the alert count: one that was already in the
 * ledger when the alert came is an earlier purchase, not this one (an
 * alert for a purchase already synced never becomes provisional at all).
 * Several candidates: the closest date wins, then the earliest. Two
 * identical purchases pair off in date order, which is all the data can
 * say about them.
 */
export function findMatches(provisional: ProvisionalRow[], synced: SyncedRow[]): { provisionalId: string; transactionId: string }[] {
  const taken = new Set<string>();
  const pairs: { provisionalId: string; transactionId: string }[] = [];
  const ordered = [...provisional].sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.createdAt.getTime() - b.createdAt.getTime());
  for (const p of ordered) {
    const best = synced
      .filter((s) => !taken.has(s.id) && s.accountId === p.accountId && s.amountCents === p.amountCents && s.createdAt > p.createdAt)
      .map((s) => ({ s, offset: dayOffset(p.postedOn, s.postedOn) }))
      .filter(({ offset }) => offset >= -DAYS_BEFORE && offset <= DAYS_AFTER)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset) || a.s.postedOn.localeCompare(b.s.postedOn))[0];
    if (!best) continue;
    taken.add(best.s.id);
    pairs.push({ provisionalId: p.id, transactionId: best.s.id });
  }
  return pairs;
}

export const isStale = (postedOn: string, today: string) => dayOffset(postedOn, today) > STALE_DAYS;
