import { describe, expect, it } from "vitest";
import { findTransferPairs, type TransferCandidate } from "@/lib/investments/transfers";

const c = (id: string, amountCents: number, postedOn: string, accountId = "checking"): TransferCandidate => ({ id, accountId, amountCents, postedOn });
const inv = (id: string, amountCents: number, postedOn: string, accountId = "brokerage"): TransferCandidate => ({ id, accountId, amountCents, postedOn });

describe("findTransferPairs", () => {
  it("pairs exactly opposite amounts within the window", () => {
    expect(findTransferPairs([c("a", -50_000, "2026-07-05")], [inv("x", 50_000, "2026-07-07")])).toEqual([{ cashId: "a", investmentId: "x" }]);
    // Money back out of the brokerage works the same way.
    expect(findTransferPairs([c("a", 20_000, "2026-07-10")], [inv("x", -20_000, "2026-07-09")])).toEqual([{ cashId: "a", investmentId: "x" }]);
  });

  it("ignores near amounts, same signs, and anything outside the window", () => {
    expect(findTransferPairs([c("a", -50_000, "2026-07-05")], [inv("x", 49_999, "2026-07-05")])).toEqual([]);
    expect(findTransferPairs([c("a", -50_000, "2026-07-05")], [inv("x", -50_000, "2026-07-05")])).toEqual([]);
    expect(findTransferPairs([c("a", -50_000, "2026-07-01")], [inv("x", 50_000, "2026-07-07")])).toEqual([]);
  });

  it("picks the closest date when one side has several candidates", () => {
    const pairs = findTransferPairs(
      [c("a", -50_000, "2026-07-01"), c("b", -50_000, "2026-07-06")],
      [inv("x", 50_000, "2026-07-02"), inv("y", 50_000, "2026-07-07")],
    );
    expect(pairs).toEqual([
      { cashId: "a", investmentId: "x" },
      { cashId: "b", investmentId: "y" },
    ]);
  });

  it("leaves ties unpaired rather than guessing", () => {
    // Two equally close deposits for one withdrawal.
    expect(
      findTransferPairs([c("a", -50_000, "2026-07-05")], [inv("x", 50_000, "2026-07-04"), inv("y", 50_000, "2026-07-06", "ira")]),
    ).toEqual([]);
    // Two withdrawals equally close to one deposit.
    expect(
      findTransferPairs([c("a", -50_000, "2026-07-04"), c("b", -50_000, "2026-07-06", "savings")], [inv("x", 50_000, "2026-07-05")]),
    ).toEqual([]);
  });
});
