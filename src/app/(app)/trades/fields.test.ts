import { describe, expect, it } from "vitest";
import { draftHeadline, missing, when } from "./fields";

// The words on a draft card (#319). Invented symbols.

describe("a draft in words", () => {
  it("says what changed and when", () => {
    expect(draftHeadline({ side: "buy", quantity: "5", symbol: "ZQXV", on: "2026-05-05", onFrom: "2026-05-03" })).toBe("5 more shares of ZQXV between May 3 and May 5");
    expect(draftHeadline({ side: "sell", quantity: "1", symbol: null, on: "2026-05-05", onFrom: null })).toBe("1 fewer share of a position with no symbol on May 5");
    expect(draftHeadline({ side: "transfer_in", quantity: "0.25", symbol: "ZQC", on: "2026-05-05", onFrom: null })).toBe("0.25 shares of ZQC moved in on May 5");
    expect(when({ on: "2026-05-05", onFrom: null })).toBe("on May 5");
  });

  it("lists what a confirm needs separately from what's optional", () => {
    expect(missing({ symbol: null, onFrom: "2026-05-03", price: null })).toEqual({ needed: ["the symbol", "the day it happened"], optional: ["the price (optional)"] });
    expect(missing({ symbol: "ZQXV", onFrom: null, price: "125" })).toEqual({ needed: [], optional: [] });
  });
});
