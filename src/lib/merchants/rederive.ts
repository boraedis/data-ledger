import { normalizeMerchant } from "@/lib/categorize/merchant";
import { ruleMatches, type RuleLike } from "@/lib/categorize/match";

// Re-running the merchant cleanup over history (#288): what it would
// change, for a preview the owner reads before applying it. Client-safe
// and pure. The raw description and payee are the input and are never
// changed; only the derived name (and, when applied, its merchant) is.
// A transaction whose merchant the owner chose by hand (pinned, #291) is
// left out entirely.

export type RederiveRow = {
  id: string;
  accountId: string;
  amountCents: number;
  description: string;
  payee: string | null;
  merchant: string | null;
  merchantId?: string | null;
  pinned: boolean;
};

export type RederiveChange = { id: string; before: string | null; after: string };

const EXAMPLES = 20;

/** The transactions whose cleaned name would change, and to what. */
export function rederive(rows: RederiveRow[]): RederiveChange[] {
  return rows.flatMap((r) => {
    if (r.pinned) return [];
    const after = normalizeMerchant(r.description, r.payee);
    return after === r.merchant ? [] : [{ id: r.id, before: r.merchant, after }];
  });
}

export type RederivePreview = {
  transactions: number;
  /** Each before → after, most transactions first, with one raw description as evidence. */
  examples: { before: string | null; after: string; transactions: number; description: string }[];
  /** Names no transaction will be under any more. */
  namesGone: number;
  /** Merchant rules whose matches change: how many transactions they'd start and stop matching. */
  rules: { id: string; pattern: string; matchType: string; gained: number; lost: number }[];
  /** Stored recurring decisions (confirmed, dismissed, cancelled) on a name that goes away. */
  series: { merchant: string; status: string }[];
  pinned: number;
};

export function rederivePreview(
  rows: RederiveRow[],
  { rules, series }: { rules: (RuleLike & { pattern: string })[]; series: { merchant: string; status: string }[] },
): RederivePreview {
  const changes = rederive(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<string, { before: string | null; after: string; transactions: number; description: string }>();
  for (const c of changes) {
    const key = `${c.before}\u0000${c.after}`;
    const g = groups.get(key) ?? { before: c.before, after: c.after, transactions: 0, description: byId.get(c.id)!.description };
    g.transactions++;
    groups.set(key, g);
  }
  // A name is gone when every transaction under it moves to another.
  const after = new Map(changes.map((c) => [c.id, c.after]));
  const remaining = new Set(rows.map((r) => after.get(r.id) ?? r.merchant).filter((m): m is string => !!m));
  const before = new Set(changes.map((c) => c.before).filter((m): m is string => !!m));
  const gone = [...before].filter((m) => !remaining.has(m));
  const merchantRules = rules.filter((r) => r.enabled && r.matchField === "merchant");
  return {
    transactions: changes.length,
    examples: [...groups.values()].sort((a, b) => b.transactions - a.transactions || a.after.localeCompare(b.after)).slice(0, EXAMPLES),
    namesGone: gone.length,
    rules: merchantRules
      .map((rule) => {
        let gained = 0;
        let lost = 0;
        for (const c of changes) {
          const r = byId.get(c.id)!;
          // A rule for a merchant (#289) is judged on the merchant the row has
          // now: a new name nearly always stays with it, so it rarely moves.
          const was = ruleMatches(rule, { ...r, merchant: c.before });
          const now = ruleMatches(rule, { ...r, merchant: c.after });
          if (now && !was) gained++;
          if (was && !now) lost++;
        }
        return { id: rule.id, pattern: rule.pattern, matchType: rule.matchType, gained, lost };
      })
      .filter((r) => r.gained || r.lost),
    series: series.filter((s) => gone.includes(s.merchant)),
    pinned: rows.filter((r) => r.pinned).length,
  };
}
