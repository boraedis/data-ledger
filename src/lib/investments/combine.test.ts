import { describe, expect, it } from "vitest";
import { addDecimals, combineHoldings } from "@/lib/investments/combine";
import type { InvestmentAccount, Position } from "@/lib/investments/summary";

// Invented accounts and positions.

describe("addDecimals", () => {
  it("adds exactly, without floating point", () => {
    expect(addDecimals("12.5", "3")).toBe("15.5");
    expect(addDecimals("0.1", "0.2")).toBe("0.3"); // 0.30000000000000004 as floats
    expect(addDecimals("10.123456789", "0.000000001")).toBe("10.12345679");
    expect(addDecimals("1.50000", "2.5")).toBe("4");
    expect(addDecimals("0", ".25")).toBe("0.25");
    expect(addDecimals("5", "-7.5")).toBe("-2.5");
    expect(addDecimals("2.5", "-2.5")).toBe("0");
  });

  it("refuses what isn't a decimal", () => {
    expect(() => addDecimals("1e3", "1")).toThrow(/Not a decimal/);
  });
});

const position = (symbol: string | null, description: string, shares: string, marketValueCents: number, costBasisCents: number | null = null): Position => ({
  externalId: `${symbol ?? description}-${shares}`,
  symbol,
  description,
  shares,
  marketValueCents,
  costBasisCents,
  gainCents: costBasisCents === null ? null : marketValueCents - costBasisCents,
});

const account = (id: string, name: string, positions: Position[] | null, valueCents: number): InvestmentAccount => {
  const held = (positions ?? []).reduce((s, p) => s + p.marketValueCents, 0);
  return {
    id,
    name,
    institution: "Example Brokerage",
    kind: "brokerage",
    manual: false,
    valueCents,
    balanceAt: null,
    holdingsOn: positions ? "2026-10-28" : null,
    positions: positions ?? [],
    cashAndOtherCents: positions ? valueCents - held : null,
    series: [],
  };
};

describe("combineHoldings", () => {
  const taxable = account("t", "Taxable Brokerage", [position("EXTM", "Example Total Market Index Fund", "12.5", 125_000, 100_000), position(null, "Example Stable Value Fund", "40", 40_000)], 170_000);
  const retirement = account("r", "Retirement 401(k)", [position("extm", "EXAMPLE TOTAL MKT IDX", "3", 30_000), position(null, "example  stable value FUND", "10", 10_000, 9_000)], 41_000);
  const manual = account("m", "Old Pension", null, 50_000);

  it("adds shares across accounts by symbol, ignoring case", () => {
    const { holdings } = combineHoldings([taxable, retirement, manual]);
    const extm = holdings.find((h) => h.symbol?.toUpperCase() === "EXTM")!;
    expect(extm).toMatchObject({ shares: "15.5", marketValueCents: 155_000 });
    expect(extm.accounts.map((a) => [a.accountName, a.shares, a.marketValueCents])).toEqual([
      ["Taxable Brokerage", "12.5", 125_000],
      ["Retirement 401(k)", "3", 30_000],
    ]);
  });

  it("combines description-only positions only when the description is the same text", () => {
    const { holdings } = combineHoldings([taxable, retirement]);
    const stable = holdings.filter((h) => h.symbol === null);
    expect(stable).toHaveLength(1);
    expect(stable[0]).toMatchObject({ shares: "50", marketValueCents: 50_000 });
    const renamed = account("x", "Other Brokerage", [position(null, "Stable Value Fund (Example)", "5", 5_000)], 5_000);
    expect(combineHoldings([taxable, renamed]).holdings.filter((h) => h.symbol === null)).toHaveLength(2);
  });

  it("marks a cost basis that only some accounts reported as partial", () => {
    const { holdings } = combineHoldings([taxable, retirement]);
    expect(holdings.find((h) => h.symbol === "EXTM")).toMatchObject({ costBasisCents: 100_000, basisComplete: false });
    const alone = combineHoldings([taxable]).holdings.find((h) => h.symbol === "EXTM")!;
    expect(alone).toMatchObject({ costBasisCents: 100_000, basisComplete: true });
  });

  it("keeps cash and other, and accounts without positions, apart from every asset", () => {
    const { holdings, cashAndOther, unreported } = combineHoldings([taxable, retirement, manual]);
    expect(cashAndOther).toEqual([
      { accountName: "Taxable Brokerage", cents: 5_000 },
      { accountName: "Retirement 401(k)", cents: 1_000 },
    ]);
    expect(unreported).toEqual([{ accountName: "Old Pension", cents: 50_000 }]);
    expect(holdings.some((h) => /cash/i.test(h.description))).toBe(false);
  });

  it("puts two lots of one asset in one account on one line", () => {
    const lots = account("l", "Lots", [position("EXTM", "Example Total Market Index Fund", "1.25", 12_500, 10_000), position("EXTM", "Example Total Market Index Fund", "0.75", 7_500, 7_000)], 20_000);
    const [extm] = combineHoldings([lots]).holdings;
    expect(extm.accounts).toEqual([{ accountId: "l", accountName: "Lots", shares: "2", marketValueCents: 20_000, costBasisCents: 17_000 }]);
  });
});
