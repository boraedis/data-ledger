import { describe, expect, it } from "vitest";
import { rankChoices } from "@/lib/categorize/choices";

const any = () => true;

describe("rankChoices", () => {
  it("puts a rule first, then the merchant's history by use, then the model, then recent", () => {
    expect(rankChoices({ rule: "rule", memory: ["b", "a", "a"], model: "model", recent: ["c", "a", "d"] }, any)).toEqual([
      { categoryId: "rule", source: "rule" },
      { categoryId: "a", source: "memory" },
      { categoryId: "b", source: "memory" },
      { categoryId: "model", source: "model" },
    ]);
  });

  it("fills from recent categories for a new merchant, without repeats or disallowed ones", () => {
    expect(rankChoices({ rule: null, memory: [], model: "x", recent: ["x", "income", "c", "c", "d", "e"] }, (id) => id !== "income")).toEqual([
      { categoryId: "x", source: "model" },
      { categoryId: "c", source: "recent" },
      { categoryId: "d", source: "recent" },
      { categoryId: "e", source: "recent" },
    ]);
  });

  it("breaks a tie in history by recency", () => {
    expect(rankChoices({ rule: null, memory: ["new", "old"], model: null, recent: [] }, any).map((c) => c.categoryId)).toEqual(["new", "old"]);
  });
});
