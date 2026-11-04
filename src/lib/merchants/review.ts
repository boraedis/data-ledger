import type { Db } from "@/db/types";
import { pendingTypeSuggestions } from "@/lib/merchants/suggest-types";
import { mergeSuggestions, suggestionEvidence } from "@/operations/merchant-views";
import { read } from "@/operations/runtime";

// What's waiting on the owner about merchants (#303): pairs that are
// probably one business (#287), with the evidence beside each, and types
// suggested for merchants without one (#293). One place, so the Merchants
// page, the Inbox and the nightly summary count the same things.

export async function merchantReview(db: Db, { pairs: shown }: { pairs: number }) {
  const [pairs, types] = await Promise.all([read(db, mergeSuggestions, {}), pendingTypeSuggestions(db)]);
  const first = pairs.slice(0, shown);
  const evidence = await suggestionEvidence(db, [...new Set(first.flatMap((p) => [p.a.id, p.b.id]))]);
  const withEvidence = (side: (typeof pairs)[number]["a"]) => ({ ...side, transactions: 0, amountCents: 0, accounts: [] as string[], lastOn: null as string | null, ...evidence.get(side.id) });
  return {
    pairs: first.map((p) => ({ reason: p.reason, a: withEvidence(p.a), b: withEvidence(p.b) })),
    pairTotal: pairs.length,
    types,
  };
}

/** Just the counts, for the nightly summary: the same as the Inbox shows. */
export async function merchantReviewCounts(db: Db) {
  const { pairTotal, types } = await merchantReview(db, { pairs: 0 });
  return { duplicates: pairTotal, types: types.length };
}
