// Matching incoming payments to what friends owe (#8). Pure and rule-based:
// a person is recognized by name in the payment's description, and amounts
// and timing decide how the payment covers their open reimbursements. These
// are only proposals — the owner confirms every match.

export type PersonNames = { id: string; name: string; aliases: string[] };

/** Uppercase letters and single spaces only: "Payment from alex.rivera!" → "PAYMENT FROM ALEX RIVERA". */
export function normalizeName(text: string): string {
  return text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z]+/g, " ")
    .trim();
}

/**
 * The person a payment description names: one of their names or aliases
 * appears as whole words. If two people match, the longer name wins
 * ("SAM OKAFOR" over "SAM"); an exact tie is ambiguous and matches no one.
 */
export function personInText(people: PersonNames[], text: string): string | null {
  const haystack = ` ${normalizeName(text)} `;
  let best: { id: string; length: number; tied: boolean } | null = null;
  for (const person of people) {
    for (const variant of [person.name, ...person.aliases]) {
      const needle = normalizeName(variant);
      if (needle.length < 2 || !haystack.includes(` ${needle} `)) continue;
      if (!best || needle.length > best.length) best = { id: person.id, length: needle.length, tied: false };
      else if (needle.length === best.length && best.id !== person.id) best.tied = true;
    }
  }
  return best && !best.tied ? best.id : null;
}

export type OpenItem = { id: string; date: string; remainingCents: number };
export type Proposal = {
  // exact: one reimbursement, same amount. combined: several adding up
  // exactly (one payment for two dinners). partial: less than what's open,
  // applied oldest first. more: more than everything open; the rest stays
  // an ordinary transaction.
  kind: "exact" | "combined" | "partial" | "more";
  allocations: { reimbursementId: string; amountCents: number }[];
};

// Payments usually follow the expense; a few days' grace covers someone
// paying ahead. Older than this and a match is more likely coincidence.
export const PAID_BEFORE_GRACE_DAYS = 3;
export const MATCH_WINDOW_DAYS = 120;
const MAX_COMBINED = 4;
const MAX_CANDIDATES = 12;

const dayGap = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * How a payment would cover someone's open reimbursements. `exactOnly`
 * limits it to exact and combined matches — the strong evidence — so the
 * caller can give those first claim before weaker partial ones.
 */
export function proposeAllocations(
  payment: { date: string; remainingCents: number },
  items: OpenItem[],
  { exactOnly = false }: { exactOnly?: boolean } = {},
): Proposal | null {
  const R = payment.remainingCents;
  if (R <= 0) return null;
  const open = items
    .filter((i) => i.remainingCents > 0)
    .filter((i) => {
      const age = dayGap(payment.date, i.date); // positive: expense before payment
      return age >= -PAID_BEFORE_GRACE_DAYS && age <= MATCH_WINDOW_DAYS;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (open.length === 0) return null;

  // 1. One reimbursement for exactly this amount; the closest in time.
  const exact = open
    .filter((i) => i.remainingCents === R)
    .sort((a, b) => Math.abs(dayGap(payment.date, a.date)) - Math.abs(dayGap(payment.date, b.date)))[0];
  if (exact) return { kind: "exact", allocations: [{ reimbursementId: exact.id, amountCents: R }] };

  // 2. Several adding up exactly — fewest items first, among the most recent.
  const recent = open.slice(-MAX_CANDIDATES);
  for (let size = 2; size <= Math.min(MAX_COMBINED, recent.length); size++) {
    const found = subsetSumming(recent, size, R);
    if (found) return { kind: "combined", allocations: found.map((i) => ({ reimbursementId: i.id, amountCents: i.remainingCents })) };
  }

  if (exactOnly) return null;

  // 3. Less than what's open: oldest first. 4. More: everything open.
  const total = open.reduce((s, i) => s + i.remainingCents, 0);
  const allocations: Proposal["allocations"] = [];
  let left = Math.min(R, total);
  for (const item of open) {
    if (left === 0) break;
    const amountCents = Math.min(item.remainingCents, left);
    allocations.push({ reimbursementId: item.id, amountCents });
    left -= amountCents;
  }
  return { kind: R < total ? "partial" : "more", allocations };
}

function subsetSumming(items: OpenItem[], size: number, target: number, start = 0): OpenItem[] | null {
  if (size === 0) return target === 0 ? [] : null;
  for (let i = start; i <= items.length - size; i++) {
    if (items[i].remainingCents > target) continue;
    const rest = subsetSumming(items, size - 1, target - items[i].remainingCents, i + 1);
    if (rest) return [items[i], ...rest];
  }
  return null;
}

/**
 * Splits `total` across parts in proportion to their sizes, in whole cents
 * that add up exactly (largest remainder). Used to take what friends owe
 * on a split transaction off each of its parts.
 */
export function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.abs(w), 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * Math.abs(w)) / sum);
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((s, f) => s + f, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}
