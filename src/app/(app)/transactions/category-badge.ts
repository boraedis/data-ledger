import { ACTIVITY_LABELS, type InvestmentActivity } from "@/lib/investments/activity";

// The category badge on a Transactions row. Pulled out of the page so the
// rule is tested: an uncategorized row says Uncategorized, never "Other"
// (#212). "Other" was the investment-activity fallback, for a brokerage or
// retirement row whose description matched no activity pattern. It read
// as a category the owner never made, and pending rows weren't the cause.

export type CategoryBadge =
  | { kind: "category"; label: string }
  | { kind: "split" }
  | { kind: "activity"; label: string }
  // Uncategorized and waiting on the owner (warning), or uncategorized in an
  // investment account, which is out of budgets and waits on nothing (plain).
  | { kind: "uncategorized"; waiting: boolean }
  | null;

export function categoryBadge(
  t: {
    isSplit: boolean;
    categoryId: string | null;
    amountCents: number;
    reimbursedCents: number;
    transfer: unknown;
    investmentActivity: InvestmentActivity | null;
  },
  labelOf: (categoryId: string) => string | undefined,
): CategoryBadge {
  if (t.isSplit) return { kind: "split" };
  if (t.categoryId) return { kind: "category", label: labelOf(t.categoryId) ?? "" };
  // A repayment fully covered, or a paired transfer, needs no category: the
  // reimbursement or transfer badge says what it is.
  if ((t.reimbursedCents >= t.amountCents && t.amountCents > 0) || t.transfer) return null;
  if (t.investmentActivity && t.investmentActivity !== "other") return { kind: "activity", label: ACTIVITY_LABELS[t.investmentActivity] };
  return { kind: "uncategorized", waiting: t.investmentActivity === null };
}
