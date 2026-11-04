import { describe, expect, it } from "vitest";
import { nearDuplicates } from "./near";

// Invented merchants only.
const m = (id: string, name: string, aliases: string[] = [name]) => ({ id, name, aliases });

describe("nearDuplicates", () => {
  it("pairs a name with the same name plus words, but not on one shared word", () => {
    const pairs = nearDuplicates([
      m("1", "Corner Bean"),
      m("2", "Corner Bean Cafe"),
      m("3", "Paypeer Payment From Alex Rivera"),
      m("4", "Paypeer Payment From Sam Okafor"),
      m("5", "Paypeer"),
      m("6", "Paypeer Transfer"),
    ]);
    expect(pairs.map((p) => [p.aId, p.bId, p.reason])).toEqual([["1", "2", "contains"]]);
  });

  it("pairs names that differ only in spaces and punctuation, or by a letter or two", () => {
    const pairs = nearDuplicates([m("1", "Smoke & Ember"), m("2", "Smoke Ember"), m("3", "Trattoria Verde"), m("4", "Tratoria Verde"), m("5", "Lucky Noodle House")]);
    expect(pairs.map((p) => [p.aId, p.bId, p.reason])).toEqual([
      ["1", "2", "punctuation"],
      ["3", "4", "spelling"],
    ]);
  });

  it("leaves short names and different businesses alone", () => {
    expect(nearDuplicates([m("1", "Zipride"), m("2", "Zipcar"), m("3", "Interest Payment"), m("4", "Interest on Cash Sweep"), m("5", "Saffron & Salt"), m("6", "Saffron Grill")])).toEqual([]);
  });

  it("compares every spelling, and skips a pair the owner rejected", () => {
    const merchants = [m("a", "Lumen", ["Lumen", "Lumen Bistro"]), m("b", "Lumen Bistro Downtown")];
    expect(nearDuplicates(merchants)).toHaveLength(1);
    expect(nearDuplicates(merchants, new Set(["a|b"]))).toEqual([]);
  });
});
