import type { InvestmentAccount } from "@/lib/investments/summary";

// Holdings across accounts (#81): each asset's total shares, value and cost
// basis, and which accounts hold it. Display only.
//
// Positions combine by symbol (ignoring case). Without a symbol, only an
// identical description combines (ignoring case and spacing): two
// institutions can describe one fund differently, but guessing that two
// descriptions are the same fund could add up shares that aren't, which is
// worse than showing two rows. "Cash and other" is never an asset and
// never combines with one.

const DECIMAL = /^(-)?(\d*)(?:\.(\d*))?$/;

/** Adds two exact decimal strings ("12.5" + "3" = "15.5"), without floating point. */
export function addDecimals(a: string, b: string): string {
  const pa = DECIMAL.exec(a.trim());
  const pb = DECIMAL.exec(b.trim());
  if (!pa || !pb) throw new Error(`Not a decimal: ${pa ? b : a}`);
  const scale = Math.max(pa[3]?.length ?? 0, pb[3]?.length ?? 0);
  const scaled = (m: RegExpExecArray) => {
    const digits = `${m[2] || "0"}${(m[3] ?? "").padEnd(scale, "0")}`;
    return BigInt(m[1] ? -1 : 1) * BigInt(digits);
  };
  const total = scaled(pa) + scaled(pb);
  const negative = total < BigInt(0);
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export type HoldingInAccount = { accountId: string; accountName: string; shares: string; marketValueCents: number; costBasisCents: number | null };

export type CombinedHolding = {
  key: string;
  symbol: string | null;
  description: string;
  shares: string;
  marketValueCents: number;
  // Summed over the accounts that reported one; `basisComplete` says
  // whether that's all of them, so a partial basis is never shown as whole.
  costBasisCents: number | null;
  basisComplete: boolean;
  accounts: HoldingInAccount[];
};

const keyOf = (p: { symbol: string | null; description: string }) =>
  p.symbol ? `symbol:${p.symbol.trim().toUpperCase()}` : `description:${p.description.trim().replace(/\s+/g, " ").toLowerCase()}`;

export function combineHoldings(accounts: InvestmentAccount[]) {
  const byKey = new Map<string, CombinedHolding>();
  const cashAndOther: { accountName: string; cents: number }[] = [];
  const unreported: { accountName: string; cents: number }[] = [];

  for (const a of accounts) {
    if (!a.holdingsOn) {
      unreported.push({ accountName: a.name, cents: a.valueCents });
      continue;
    }
    for (const p of a.positions) {
      const key = keyOf(p);
      const held = byKey.get(key) ?? {
        key,
        symbol: p.symbol,
        description: p.description,
        shares: "0",
        marketValueCents: 0,
        costBasisCents: null,
        basisComplete: true,
        accounts: [],
      };
      held.shares = addDecimals(held.shares, p.shares);
      held.marketValueCents += p.marketValueCents;
      if (p.costBasisCents === null) held.basisComplete = false;
      else held.costBasisCents = (held.costBasisCents ?? 0) + p.costBasisCents;
      // One account can list the same asset twice (two lots): one line each.
      const inAccount = held.accounts.find((x) => x.accountId === a.id);
      if (inAccount) {
        inAccount.shares = addDecimals(inAccount.shares, p.shares);
        inAccount.marketValueCents += p.marketValueCents;
        inAccount.costBasisCents = inAccount.costBasisCents === null || p.costBasisCents === null ? null : inAccount.costBasisCents + p.costBasisCents;
      } else {
        held.accounts.push({ accountId: a.id, accountName: a.name, shares: p.shares, marketValueCents: p.marketValueCents, costBasisCents: p.costBasisCents });
      }
      byKey.set(key, held);
    }
    if (a.cashAndOtherCents) cashAndOther.push({ accountName: a.name, cents: a.cashAndOtherCents });
  }

  const holdings = [...byKey.values()]
    .map((h) => ({ ...h, accounts: h.accounts.sort((x, y) => y.marketValueCents - x.marketValueCents) }))
    .sort((x, y) => y.marketValueCents - x.marketValueCents);
  return { holdings, cashAndOther, unreported };
}
