// Account kinds, in their own dependency-free module so client components
// can use them without pulling the database schema into the browser bundle.

// Cash kinds (the first four) are where spending happens; the rest hold or
// owe value and stay out of budgets by default.
export const ACCOUNT_KINDS = [
  "checking",
  "savings",
  "credit",
  "payment_app",
  "brokerage",
  "retirement",
  "loan",
  "other_asset",
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const KIND_LABELS: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  payment_app: "Payment app",
  brokerage: "Brokerage",
  retirement: "Retirement",
  loan: "Loan",
  other_asset: "Other asset",
};

/** Whether a new account of this kind counts toward budgets unless the owner says otherwise. */
export function countsTowardBudgetsByDefault(kind: AccountKind): boolean {
  return kind === "checking" || kind === "savings" || kind === "credit" || kind === "payment_app";
}
