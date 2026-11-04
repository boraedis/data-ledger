import { describe, expect, it } from "vitest";
import { cashSignal, descriptionShape, renderSurvey, surveyBrokerages, type SurveySnapshot } from "@/lib/trades/survey";

// The brokerage survey (#316), on invented institutions, funds and symbols.

const snap = (on: string, externalId: string, shares: string, marketValueCents: number, extra: Partial<SurveySnapshot> = {}): SurveySnapshot => ({
  accountId: "a1",
  on,
  externalId,
  symbol: externalId,
  description: `${externalId} Example Growth Fund`,
  shares,
  marketValueCents,
  costBasisCents: null,
  ...extra,
});

describe("descriptionShape", () => {
  it("keeps brokerage words and masks names, numbers and money", () => {
    expect(descriptionShape("YOU BOUGHT ZQXV Example Growth Fund 2.500 @ 125.00")).toBe("YOU BOUGHT … FUND # @ #");
    expect(descriptionShape("Dividend received Harlow Widgets Inc $12.34")).toBe("DIVIDEND RECEIVED … $#");
  });
});

describe("cashSignal", () => {
  it("knows a sweep fund by name or by its $1.00 price, and a holding by neither", () => {
    expect(cashSignal({ symbol: "ZZMM", description: "Example Money Market Fund", shares: "10", marketValueCents: 5_000 })).toBe("named as cash");
    expect(cashSignal({ symbol: "ZZCX", description: "Core holding", shares: "412.37", marketValueCents: 41_237 })).toBe("priced at $1.00");
    expect(cashSignal({ symbol: "ZQXV", description: "Example Growth Fund", shares: "2", marketValueCents: 25_000 })).toBeNull();
  });
});

describe("surveyBrokerages", () => {
  const accounts = [
    { id: "a1", institution: "Example Brokerage", type: "brokerage" },
    { id: "a2", institution: "Sample Retirement Co", type: "retirement" },
  ];
  const transactions = [
    { accountId: "a1", postedOn: "2026-05-02", description: "YOU BOUGHT ZQXV 2.000 SHARES", payee: null, memo: null },
    { accountId: "a1", postedOn: "2026-05-20", description: "DIVIDEND RECEIVED", payee: null, memo: null },
    { accountId: "a1", postedOn: "2026-05-21", description: "Example payment", payee: null, memo: null },
  ];
  const snapshots = [
    snap("2026-05-01", "ZQXV", "10", 125_000, { costBasisCents: 100_000 }),
    snap("2026-05-01", "ZZMM", "500", 50_000, { description: "Example Money Market" }),
    snap("2026-05-03", "ZQXV", "12", 150_000, { costBasisCents: 125_000 }),
    snap("2026-05-03", "ZZMM", "250", 25_000, { description: "Example Money Market" }),
    snap("2026-05-03", "FUND-77", "3", 3_000, { symbol: null }),
    snap("2026-05-04", "ZQXV", "12", 150_000, { costBasisCents: 125_000 }),
    snap("2026-05-04", "ZZMM", "250", 25_000, { description: "Example Money Market" }),
    snap("2026-05-04", "FUND-77", "3", 3_000, { symbol: null }),
  ];
  const [brokerage, retirement] = surveyBrokerages({ accounts, transactions, snapshots }, "2026-06-01");

  it("counts cash rows, how far back they go, and what the patterns recognize", () => {
    expect(brokerage).toMatchObject({ institution: "Example Brokerage", accounts: 1, transactions: 3, daysBack: 30, activity: { buy: 1, dividend: 1, other: 1 } });
    expect(brokerage.withSymbolLikeToken).toBe(1);
    expect(brokerage.withQuantityLikeNumber).toBe(1);
  });

  it("describes positions: symbol-less ones, cost basis, and cash left out of changes", () => {
    expect(brokerage).toMatchObject({ snapshotDays: 3, positions: 3, withoutSymbol: 1, costBasisFilled: 1, cashLike: { count: 1, signals: ["named as cash"] } });
    // 05-01 → 05-03: the buy and the new fund (the money market fell too, but it's cash). 05-03 → 05-04: nothing.
    expect(brokerage).toMatchObject({ intervals: 2, intervalsWithChange: 1, mostPositionsChangedAtOnce: 2, medianDaysBetweenSnapshots: 2 });
    // $250.00 more cost basis over 2 more shares is $125.00, the day's price.
    expect(brokerage.costBasisPrice).toEqual({ checked: 1, agrees: 1 });
  });

  it("reports an institution with nothing synced, without failing", () => {
    expect(retirement).toMatchObject({ transactions: 0, daysBack: null, positions: 0, intervals: 0 });
  });

  it("renders no account ids, symbols, quantities or values", () => {
    const text = renderSurvey([brokerage, retirement]);
    expect(text).toContain("Example Brokerage");
    for (const leak of ["a1", "ZQXV", "ZZMM", "FUND-77", "Growth", "1250", "125.00", "2026-05"]) expect(text).not.toContain(leak);
  });
});
