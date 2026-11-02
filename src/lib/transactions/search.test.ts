import { describe, expect, it } from "vitest";
import { searchTerms } from "./search";

describe("searchTerms (#213)", () => {
  it("reads an amount, with a sign only when one is typed", () => {
    expect(searchTerms("42.50").amount).toEqual({ cents: 4250, signed: false });
    expect(searchTerms("-42.50").amount).toEqual({ cents: -4250, signed: true });
    expect(searchTerms("+42.5").amount).toEqual({ cents: 4250, signed: true });
    expect(searchTerms("$1,234.56").amount).toEqual({ cents: 123_456, signed: false });
    expect(searchTerms("-$42").amount).toEqual({ cents: -4200, signed: true });
  });

  it("isn't fooled by text, a third decimal or a misplaced comma", () => {
    for (const s of ["coffee", "42.505", "1,23", "4 2", "$", "-"]) expect(searchTerms(s).amount, s).toBeNull();
  });

  it("reads a real date, ISO or US order", () => {
    expect(searchTerms("2026-10-19").date).toBe("2026-10-19");
    expect(searchTerms("10/19/2026").date).toBe("2026-10-19");
    expect(searchTerms("2026-02-30").date).toBeNull();
    expect(searchTerms("13/01/2026").date).toBeNull();
    expect(searchTerms("2026").date).toBeNull();
  });
});
