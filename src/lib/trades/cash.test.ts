import { describe, expect, it } from "vitest";
import { cashSignal, isCashMove } from "@/lib/trades/cash";

// What counts as cash (#320), tuned to what the brokerage survey found
// (#316). Patterns rewritten with invented funds and symbols.

const position = (description: string, shares: string, marketValueCents: number, symbol: string | null = "ZZX") => ({ symbol, description, shares, marketValueCents });

describe("cashSignal", () => {
  it("knows a sweep or core fund by its name or its $1.00 price", () => {
    expect(cashSignal(position("Example Government Money Market", "500", 50_000))).toBe("named as cash");
    expect(cashSignal(position("Example Core Account", "12", 1_300))).toBe("named as cash");
    expect(cashSignal(position("Example Liquid Reserve", "412.37", 41_237))).toBe("priced at $1.00");
  });

  it("doesn't take a bond or CD held at par for cash", () => {
    expect(cashSignal(position("Example Bank CD 4.5% Matures 2027", "10000", 1_000_000))).toBeNull();
    expect(cashSignal(position("Example City Muni Bond", "5000", 500_000))).toBeNull();
    expect(cashSignal(position("US Treasury Note", "2000", 200_000))).toBeNull();
  });
});

describe("isCashMove", () => {
  it("knows a sweep into or out of the core account, even with the word cash in every row", () => {
    expect(isCashMove("PURCHASE INTO CORE ACCOUNT EXAMPLE MONEY MARKET (CASH)")).toBe(true);
    expect(isCashMove("REDEMPTION FROM CORE ACCOUNT ZZCXX (CASH) TRADE CASH")).toBe(true);
    expect(isCashMove("YOU BOUGHT ZQXV EXAMPLE GROWTH FUND (CASH)")).toBe(false);
  });
});
