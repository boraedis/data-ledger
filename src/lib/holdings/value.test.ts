import { describe, expect, it } from "vitest";
import { normalizeQuantity, positionValueCents } from "./value";

// Invented quantities and prices.

describe("positionValueCents (#231)", () => {
  it("multiplies exactly, with no float error", () => {
    expect(positionValueCents("0.5", "40000")).toBe(2_000_000);
    expect(positionValueCents("0.1", "0.2")).toBe(2);
    expect(positionValueCents("3", "0.333333")).toBe(100);
    expect(positionValueCents("0.00012345", "61234.56")).toBe(756);
    expect(positionValueCents("1250000", "0.00001234")).toBe(1_543);
  });

  it("rounds half a cent up", () => {
    expect(positionValueCents("1", "0.005")).toBe(1);
    expect(positionValueCents("1", "0.0049")).toBe(0);
  });
});

describe("normalizeQuantity", () => {
  it("accepts plain decimals with commas, in a canonical form", () => {
    expect(["0.50", "1,234.5", "007", "12."].map(normalizeQuantity)).toEqual(["0.5", "1234.5", "7", null]);
  });

  it("refuses signs, exponents and text", () => {
    expect(["-1", "1e3", "abc", "", "1.2.3"].map(normalizeQuantity)).toEqual([null, null, null, null, null]);
  });
});
