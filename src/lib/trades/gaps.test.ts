import { describe, expect, it } from "vitest";
import { pairTransfers, splitRatio, type PlannedTrade } from "@/lib/trades/gaps";

// The parts of gap drafting that tell a trade from a split or a transfer (#324). Invented values.

const pos = (shares: string, marketValueCents: number) => ({ key: "ZQXV", symbol: "ZQXV", externalId: "ZQXV", shares, marketValueCents });

describe("splitRatio", () => {
  it("knows forward and reverse splits by a clean ratio and a steady value", () => {
    expect(splitRatio(pos("10", 100_000), pos("20", 104_000), "10")).toBe("2");
    expect(splitRatio(pos("10", 100_000), pos("15", 99_000), "10")).toBe("1.5");
    expect(splitRatio(pos("30", 100_000), pos("10", 97_000), "30")).toBe("0.333333");
  });

  it("isn't fooled by a buy, an odd ratio, or trades that didn't explain the shares before", () => {
    expect(splitRatio(pos("10", 100_000), pos("20", 200_000), "10")).toBeNull();
    expect(splitRatio(pos("10", 100_000), pos("17", 101_000), "10")).toBeNull();
    expect(splitRatio(pos("10", 100_000), pos("20", 101_000), "8")).toBeNull();
  });
});

describe("pairTransfers", () => {
  const draft = (side: "buy" | "sell", quantity = "2", extra: Partial<PlannedTrade> = {}): PlannedTrade => ({
    key: "ZQXV", symbol: "ZQXV", positionId: null, side, quantity, on: "2026-05-02", onFrom: null, kind: "trade", ratio: null, ...extra,
  });

  it("pairs one sale and one buy of the same quantity in two accounts", () => {
    const plans = [{ accountId: "a", drafts: [draft("sell")] }, { accountId: "b", drafts: [draft("buy", "2.0")] }];
    pairTransfers(plans);
    expect(plans.map((p) => [p.drafts[0].side, p.drafts[0].kind, p.drafts[0].pair])).toEqual([
      ["transfer_out", "transfer", "t1"],
      ["transfer_in", "transfer", "t1"],
    ]);
  });

  it("leaves them be when the quantity, the account, or the certainty doesn't fit", () => {
    const differ = [{ accountId: "a", drafts: [draft("sell")] }, { accountId: "b", drafts: [draft("buy", "3")] }];
    const same = [{ accountId: "a", drafts: [draft("sell"), draft("buy")] }];
    const two = [{ accountId: "a", drafts: [draft("sell")] }, { accountId: "b", drafts: [draft("buy")] }, { accountId: "c", drafts: [draft("buy")] }];
    for (const plans of [differ, same, two]) {
      pairTransfers(plans);
      expect(plans.flatMap((p) => p.drafts.map((d) => d.kind))).not.toContain("transfer");
    }
  });
});
