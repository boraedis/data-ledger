// Recognizing money moved between a cash account and an investment account
// (#24): -$500 out of checking and +$500 into the brokerage two days later
// is one transfer, not a $500 expense. Rule-based and conservative — a wrong
// pair hides a real expense from budgets, which is worse than leaving a
// transfer in the inbox for the owner to file.
//
// A pair is: one transaction in a cash account and one in an investment
// account, amounts exactly opposite, posted within TRANSFER_WINDOW_DAYS of
// each other. Each side pairs with its closest-dated candidate; if two
// candidates are equally close, it's ambiguous and neither is paired.

export const TRANSFER_WINDOW_DAYS = 5;

export type TransferCandidate = { id: string; accountId: string; amountCents: number; postedOn: string };

const DAY_MS = 86_400_000;
const gapDays = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

export function findTransferPairs(
  cash: TransferCandidate[],
  investment: TransferCandidate[],
): { cashId: string; investmentId: string }[] {
  type Edge = { cash: TransferCandidate; inv: TransferCandidate; gap: number };
  const edges: Edge[] = [];
  const byAmount = new Map<number, TransferCandidate[]>();
  for (const inv of investment) byAmount.set(inv.amountCents, [...(byAmount.get(inv.amountCents) ?? []), inv]);
  for (const c of cash) {
    if (c.amountCents === 0) continue;
    for (const inv of byAmount.get(-c.amountCents) ?? []) {
      const gap = gapDays(c.postedOn, inv.postedOn);
      if (gap <= TRANSFER_WINDOW_DAYS && inv.accountId !== c.accountId) edges.push({ cash: c, inv, gap });
    }
  }

  // Closest gap first; a side whose best option ties with another is
  // ambiguous and sits out, as does anything left competing for it.
  const best = (key: (e: Edge) => string) => {
    const result = new Map<string, Edge[]>();
    for (const e of edges) {
      const list = result.get(key(e)) ?? [];
      if (!list.length || e.gap < list[0].gap) result.set(key(e), [e]);
      else if (e.gap === list[0].gap) list.push(e);
    }
    return result;
  };
  const bestForCash = best((e) => e.cash.id);
  const bestForInv = best((e) => e.inv.id);

  const pairs: { cashId: string; investmentId: string }[] = [];
  for (const [cashId, options] of bestForCash) {
    if (options.length !== 1) continue;
    const [edge] = options;
    const reverse = bestForInv.get(edge.inv.id)!;
    // Mutual and unique: this cash row is the investment row's only
    // closest match, and vice versa.
    if (reverse.length === 1 && reverse[0].cash.id === cashId) pairs.push({ cashId, investmentId: edge.inv.id });
  }
  return pairs;
}
