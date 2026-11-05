// Cash isn't a holding (#320): uninvested money in a brokerage shows up as a
// sweep or money-market fund, or a plain cash line, and it moves with every
// buy, sell and dividend. Treated as a holding, every buy would come with a
// draft selling the money-market fund. Gap drafting leaves these out, and
// the brokerage survey (#316) counts them with the same rule.

const CASH_WORDS = /money ?market|\bcash\b|sweep|core position|settlement fund|liquidity|deposit program|\bfdic\b|\bmmf\b/i;

/** Why a position looks like cash rather than a holding, or null. */
export function cashSignal(p: { symbol: string | null; description: string; shares: string; marketValueCents: number }): string | null {
  if (CASH_WORDS.test(p.description) || (p.symbol && CASH_WORDS.test(p.symbol))) return "named as cash";
  const shares = Number(p.shares);
  // Priced at exactly $1.00 a share: what a sweep fund is, and few holdings are.
  if (shares > 0 && Math.abs(p.marketValueCents / 100 / shares - 1) < 0.0005) return "priced at $1.00";
  return null;
}
