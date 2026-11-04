import { describe, expect, it } from "vitest";
import type { RuleLike } from "@/lib/categorize/match";
import { rederive, rederivePreview, type RederiveRow } from "./rederive";

// Invented descriptors, with the names an older cleanup gave them.
const row = (id: string, description: string, merchant: string | null, pinned = false): RederiveRow => ({
  id,
  accountId: "acct",
  amountCents: -1000,
  description,
  payee: null,
  merchant,
  pinned,
});
const rows = [
  row("1", "CORNER BEAN CAFE      SPRINGFIELD   IL", "Corner Bean Cafe Springfield Il"),
  row("2", "CORNER BEAN CAFE      SPRINGFIELD   IL", "Corner Bean Cafe Springfield Il"),
  row("3", "CORNER BEAN CAFE, RIVERTON, WA", "Corner Bean Cafe, Riverton, Wa"),
  row("4", "CORNER BEAN CAFE      SPRINGFIELD   IL", "Corner Bean Springfield", true),
  row("5", "QUILLFIELD MARKET #0412", "Quillfield Market"),
];
const rule = (id: string, pattern: string, matchType: RuleLike["matchType"]): RuleLike => ({
  id,
  matchField: "merchant",
  matchType,
  pattern,
  accountId: null,
  minAmountCents: null,
  maxAmountCents: null,
  categoryId: "c",
  enabled: true,
});

describe("rederive", () => {
  it("changes only names the cleanup now gives differently, leaving pinned ones alone", () => {
    expect(rederive(rows)).toEqual([
      { id: "1", before: "Corner Bean Cafe Springfield Il", after: "Corner Bean Cafe" },
      { id: "2", before: "Corner Bean Cafe Springfield Il", after: "Corner Bean Cafe" },
      { id: "3", before: "Corner Bean Cafe, Riverton, Wa", after: "Corner Bean Cafe" },
    ]);
  });
});

describe("rederivePreview", () => {
  it("counts, groups examples, and finds rules and recurring decisions affected", () => {
    const p = rederivePreview(rows, {
      rules: [rule("eq", "Corner Bean Cafe Springfield Il", "equals"), rule("start", "Corner Bean", "starts_with"), rule("new", "corner bean cafe", "equals")],
      series: [
        { merchant: "Corner Bean Cafe, Riverton, Wa", status: "confirmed" },
        { merchant: "Quillfield Market", status: "dismissed" },
      ],
    });
    expect(p.transactions).toBe(3);
    expect(p.examples[0]).toEqual({ before: "Corner Bean Cafe Springfield Il", after: "Corner Bean Cafe", transactions: 2, description: "CORNER BEAN CAFE      SPRINGFIELD   IL" });
    expect(p.namesGone).toBe(2);
    // starts_with still matches before and after: not affected.
    expect(p.rules).toEqual([
      { id: "eq", pattern: "Corner Bean Cafe Springfield Il", matchType: "equals", gained: 0, lost: 2 },
      { id: "new", pattern: "corner bean cafe", matchType: "equals", gained: 3, lost: 0 },
    ]);
    expect(p.series).toEqual([{ merchant: "Corner Bean Cafe, Riverton, Wa", status: "confirmed" }]);
    expect(p.pinned).toBe(1);
  });
});
