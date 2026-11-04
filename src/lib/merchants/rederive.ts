import { merchantSource, nameFor } from "@/lib/categorize/merchant";
import { ruleMatches, type RuleLike } from "@/lib/categorize/match";

// Re-running the merchant cleanup over history (#288): what it would
// change, for a preview the owner reads before applying it. Client-safe
// and pure. The raw description and payee are the input and are never
// changed; only the derived name (and, when applied, its merchant) is.
// A transaction whose merchant the owner chose by hand (pinned, #291) is
// left out entirely. A name the owner chose for a raw text (#305) is what
// the cleanup gives for it: once chosen, the re-run agrees with it.

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

// Every change is listed, so each can be ticked or edited (#305); this many
// at most, and Apply touches only what was listed.
const EXAMPLES = 300;

export const groupKey = (g: { before: string | null; after: string }) => `${g.before ?? ""}\u0000${g.after}`;

/** The transactions whose cleaned name would change, and to what. */
export function rederive(rows: RederiveRow[], overrides: ReadonlyMap<string, string> = new Map()): RederiveChange[] {
  return rows.flatMap((r) => {
    if (r.pinned) return [];
    const after = nameFor(r.description, r.payee, overrides);
    return after === r.merchant ? [] : [{ id: r.id, before: r.merchant, after }];
  });
}

export type RederivePreview = {
  transactions: number;
  /** Each before → after, most transactions first, with one raw description as evidence. */
  examples: { key: string; before: string | null; after: string; transactions: number; description: string }[];
  /** Changes past the list's length, which Apply leaves for another run. */
  unlisted: number;
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
  { rules, series, overrides = new Map() }: { rules: (RuleLike & { pattern: string })[]; series: { merchant: string; status: string }[]; overrides?: ReadonlyMap<string, string> },
): RederivePreview {
  const changes = rederive(rows, overrides);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<string, { key: string; before: string | null; after: string; transactions: number; description: string }>();
  for (const c of changes) {
    const key = groupKey(c);
    const g = groups.get(key) ?? { key, before: c.before, after: c.after, transactions: 0, description: byId.get(c.id)!.description };
    g.transactions++;
    groups.set(key, g);
  }
  // A name is gone when every transaction under it moves to another.
  const after = new Map(changes.map((c) => [c.id, c.after]));
  const remaining = new Set(rows.map((r) => after.get(r.id) ?? r.merchant).filter((m): m is string => !!m));
  const before = new Set(changes.map((c) => c.before).filter((m): m is string => !!m));
  const gone = [...before].filter((m) => !remaining.has(m));
  const merchantRules = rules.filter((r) => r.enabled && r.matchField === "merchant");
  const sorted = [...groups.values()].sort((a, b) => b.transactions - a.transactions || a.after.localeCompare(b.after));
  const listed = sorted.slice(0, EXAMPLES);
  return {
    transactions: changes.length,
    examples: listed,
    unlisted: changes.length - listed.reduce((s, g) => s + g.transactions, 0),
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

/** The distinct raw texts behind one before → after, for remembering the owner's choice on each (#305). */
export function sourcesOf(rows: RederiveRow[], changes: RederiveChange[], key: string): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...new Set(changes.filter((c) => groupKey(c) === key).map((c) => merchantSource(byId.get(c.id)!.description, byId.get(c.id)!.payee)))];
}
