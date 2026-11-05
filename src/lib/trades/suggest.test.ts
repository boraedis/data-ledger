import { describe, expect, it } from "vitest";
import { quantityFor, suggest, type DraftFacts } from "@/lib/trades/suggest";

// Suggestions for what a draft trade lacks (#323). Invented symbols, positions and prices.

const facts = (extra: Partial<DraftFacts> = {}): DraftFacts => ({
  side: "buy",
  quantity: "2",
  symbol: "ZQXV",
  on: "2026-05-05",
  onFrom: "2026-05-02",
  price: null,
  before: { on: "2026-05-01", shares: "10", marketValueCents: 120_000, costBasisCents: 100_000 },
  after: { on: "2026-05-05", shares: "12", marketValueCents: 151_200, costBasisCents: 125_000 },
  cashCents: null,
  closes: [
    { on: "2026-05-01", price: 120 },
    { on: "2026-05-04", price: 125.1 },
    { on: "2026-05-05", price: 126 },
  ],
  namedSymbols: [],
  ...extra,
});
const fields = (f: DraftFacts) => suggest(f).suggestions.map((s) => [s.field, s.value]);

describe("a missing price", () => {
  it("comes first from the change in cost basis, ahead of the market price", () => {
    const { suggestions } = suggest(facts());
    expect(suggestions[0]).toEqual({ field: "price", value: "125", basis: "about $125.00, from the change in cost basis" });
    expect(suggestions[1]).toMatchObject({ field: "price", value: "126", basis: "$126.00, the closing price on May 5" });
  });

  it("comes from the cash row when there's one, and from the position's value for a fund with no quote", () => {
    expect(fields(facts({ before: null, after: null, cashCents: -25_000, closes: [] }))).toEqual([["price", "125"]]);
    expect(suggest(facts({ before: null, after: { on: "2026-05-05", shares: "12", marketValueCents: 151_200, costBasisCents: null }, closes: [] })).suggestions).toEqual([
      { field: "price", value: "126", basis: "about $126.00, the position's value over its shares on May 5" },
    ]);
  });

  it("isn't offered when nothing gives one, and the draft says so", () => {
    const { suggestions, notes } = suggest(facts({ before: null, after: null, closes: [] }));
    expect(suggestions).toEqual([]);
    expect(notes).toEqual(["No price for these days yet, and no cost basis or cash row to work one out from."]);
  });

  it("isn't worked out from cost basis on a sale, which lowers it by the average cost, not the price", () => {
    expect(fields(facts({ side: "sell" }))[0]).toEqual(["price", "126"]);
  });
});

describe("a missing day", () => {
  it("is the day in the range whose close is nearest the price", () => {
    expect(suggest(facts()).suggestions.find((s) => s.field === "on")).toEqual({ field: "on", value: "2026-05-04", basis: "May 4, when it closed at $125.10, nearest $125.00" });
    expect(suggest(facts({ price: "126" })).suggestions).toEqual([{ field: "on", value: "2026-05-05", basis: "May 5, when it closed at $126.00, nearest $126.00" }]);
  });

  it("isn't guessed from the closes alone", () => {
    expect(fields(facts({ before: null, after: null })).filter(([f]) => f === "on")).toEqual([]);
  });
});

describe("a missing symbol, a commission and a quantity", () => {
  it("suggests what the cash rows around it name", () => {
    expect(fields(facts({ symbol: null, closes: [], namedSymbols: [{ symbol: "ZQAB", on: "2026-05-04" }, { symbol: "ZQAB", on: "2026-05-04" }] })).filter(([f]) => f === "symbol")).toEqual([["symbol", "ZQAB"]]);
  });

  it("notes a cash row that's about a commission off the market, and picks neither", () => {
    const { notes } = suggest(facts({ price: "126", cashCents: -25_995 }));
    expect(notes).toEqual(["The cash row is $7.95 more than 2 × the close: maybe a commission or fee."]);
  });

  it("works out shares from a cash amount and the day's close", () => {
    expect(quantityFor(-25_000, { on: "2026-05-04", price: 125 })).toEqual({ field: "quantity", value: "2", basis: "about 2 shares, at the $125.00 close on May 4" });
    expect(quantityFor(-25_000, null)).toBeNull();
  });
});
