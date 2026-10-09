// Pure decision logic for the categorization pipeline: which rule matches,
// and what merchant memory says. No database, so it's cheap to test and
// identical wherever it runs (pipeline, inbox suggestions).

export type RuleLike = {
  id: string;
  matchField: "merchant" | "description";
  matchType: "equals" | "contains" | "starts_with";
  pattern: string;
  accountId: string | null;
  minAmountCents: number | null;
  maxAmountCents: number | null;
  categoryId: string;
  enabled: boolean;
};

export type TxnLike = {
  accountId: string;
  amountCents: number;
  description: string;
  merchant: string | null;
};

export function ruleMatches(rule: RuleLike, txn: TxnLike): boolean {
  if (!rule.enabled) return false;
  if (rule.accountId && rule.accountId !== txn.accountId) return false;
  const magnitude = Math.abs(txn.amountCents);
  if (rule.minAmountCents != null && magnitude < rule.minAmountCents) return false;
  if (rule.maxAmountCents != null && magnitude > rule.maxAmountCents) return false;

  const haystack = (rule.matchField === "merchant" ? (txn.merchant ?? "") : txn.description).toLowerCase().trim();
  const needle = rule.pattern.toLowerCase().trim();
  switch (rule.matchType) {
    case "equals":
      return haystack === needle;
    case "starts_with":
      return haystack.startsWith(needle);
    case "contains":
      return haystack.includes(needle);
  }
}

/** The first matching rule, given rules already in run order. */
export function firstMatchingRule<R extends RuleLike>(rules: R[], txn: TxnLike): R | undefined {
  return rules.find((rule) => ruleMatches(rule, txn));
}

// How many of a merchant's most recent categorizations memory looks at.
export const MEMORY_WINDOW = 5;

export type MemoryVerdict =
  | { kind: "apply"; categoryId: string } // consistent history: categorize automatically
  | { kind: "suggest"; categoryId: string } // mixed history: offer the most common, let the owner decide
  | { kind: "none" };

/**
 * Merchant memory over a merchant's recent categories, newest first. One
 * consistent past categorization is enough to repeat it — "learns instead
 * of nagging" — but if the owner has categorized this merchant
 * differently recently, it's ambiguous (groceries vs. a gift at the same
 * store) and goes to the inbox as a suggestion instead.
 */
export function merchantMemory(recentCategoryIds: string[]): MemoryVerdict {
  const window = recentCategoryIds.slice(0, MEMORY_WINDOW);
  if (window.length === 0) return { kind: "none" };
  const counts = new Map<string, number>();
  for (const id of window) counts.set(id, (counts.get(id) ?? 0) + 1);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || window.indexOf(a[0]) - window.indexOf(b[0]));
  return counts.size === 1 ? { kind: "apply", categoryId: top[0] } : { kind: "suggest", categoryId: top[0] };
}
