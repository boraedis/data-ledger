// Cash isn't a holding (#320): uninvested money in a brokerage shows up as a
// sweep or money-market fund, or a plain cash line, and it moves with every
// buy, sell and dividend. Treated as a holding, every buy would come with a
// draft selling the money-market fund. Gap drafting leaves these out, and
// the brokerage survey (#316) counts them with the same rule.

const CASH_WORDS = /money ?market|\bcash\b|sweep|core (position|account)|settlement fund|liquidity|deposit program|\bfdic\b|\bmmf\b/i;

// What's priced at $1.00 a unit without being cash: a bond, CD or note held
// at par is quoted per dollar of face value. The survey (#316) found bonds at
// a brokerage that also has $1.00 sweep funds, so price alone can't say.
const FIXED_INCOME_WORDS = /\b(bonds?|cds?|certificates? of deposit|notes?|treasur(y|ies)|t-?bills?|muni(cipal)?s?|debentures?|coupon|matur(es|ity))\b/i;

/** Why a position looks like cash rather than a holding, or null. */
export function cashSignal(p: { symbol: string | null; description: string; shares: string; marketValueCents: number }): string | null {
  if (CASH_WORDS.test(p.description) || (p.symbol && CASH_WORDS.test(p.symbol))) return "named as cash";
  if (FIXED_INCOME_WORDS.test(p.description)) return null;
  const shares = Number(p.shares);
  // Priced at exactly $1.00 a share: what a sweep fund is, and few holdings are.
  if (shares > 0 && Math.abs(p.marketValueCents / 100 / shares - 1) < 0.0005) return "priced at $1.00";
  return null;
}

// A brokerage cash row that moves money into or out of its own cash fund,
// not a trade (#316): the survey found one brokerage reporting every sweep
// as "PURCHASE INTO CORE ACCOUNT" and "REDEMPTION FROM CORE ACCOUNT", which
// read as a buy and a sale. Not \bcash\b here: the same brokerage puts the
// word "cash" in every row, real buys included.
const CASH_MOVE_WORDS = /core (account|position)|money ?market|\bsweep\b|settlement fund|deposit program|\bmmf\b/i;

/** Whether a cash row's text says it's a sweep into or out of the account's cash fund. */
export function isCashMove(text: string): boolean {
  return CASH_MOVE_WORDS.test(text);
}
