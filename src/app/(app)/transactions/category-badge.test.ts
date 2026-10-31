import { describe, expect, it } from "vitest";
import { categoryBadge } from "./category-badge";

// The Transactions row's category badge (#212). Invented values.

const row = (extra: Partial<Parameters<typeof categoryBadge>[0]> = {}) => ({
  isSplit: false,
  categoryId: null,
  amountCents: -4_250,
  reimbursedCents: 0,
  transfer: null,
  investmentActivity: null,
  ...extra,
});
const labelOf = (id: string) => ({ dining: "Food › Dining" })[id];

describe("categoryBadge", () => {
  it("names the category, or Split", () => {
    expect(categoryBadge(row({ categoryId: "dining" }), labelOf)).toEqual({ kind: "category", label: "Food › Dining" });
    expect(categoryBadge(row({ isSplit: true }), labelOf)).toEqual({ kind: "split" });
  });

  it("says Uncategorized for an uncategorized row, waiting on the owner", () => {
    expect(categoryBadge(row(), labelOf)).toEqual({ kind: "uncategorized", waiting: true });
  });

  it("never says Other: an investment row with no recognised activity is Uncategorized, and not waiting", () => {
    expect(categoryBadge(row({ investmentActivity: "other" }), labelOf)).toEqual({ kind: "uncategorized", waiting: false });
    expect(categoryBadge(row({ investmentActivity: "dividend", amountCents: 1_200 }), labelOf)).toEqual({ kind: "activity", label: "Dividend" });
  });

  it("shows nothing for a paired transfer or a repayment covered in full", () => {
    expect(categoryBadge(row({ transfer: { transactionId: "t2", accountId: "savings" } }), labelOf)).toBeNull();
    expect(categoryBadge(row({ amountCents: 3_000, reimbursedCents: 3_000 }), labelOf)).toBeNull();
  });
});
