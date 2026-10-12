import type { AccountKind } from "@/lib/account-kinds";

// What a transaction in a brokerage or retirement account is (#24): rule-
// based, from the description, never a model call. Computed when read rather
// than stored, so reclassifying an account (or improving these patterns)
// changes its history with no backfill.
//
// None of it is spending or income for budgets — those accounts are out of
// budgets by default — but dividends and interest are shown as investment
// income, kept apart from paychecks.

export const INVESTMENT_KINDS: readonly AccountKind[] = ["brokerage", "retirement"];

// Where money comes from or goes to when it moves into an investment
// account. Credit cards and loans aren't here: nobody funds a brokerage from
// a card, and allowing it would only add false matches.
export const CASH_KINDS: readonly AccountKind[] = ["checking", "savings", "payment_app"];

export function isInvestmentKind(kind: AccountKind): boolean {
  return INVESTMENT_KINDS.includes(kind);
}

export type InvestmentActivity =
  | "dividend"
  | "interest"
  | "reinvestment"
  | "buy"
  | "sell"
  | "fee"
  | "transfer"
  | "other";

export const ACTIVITY_LABELS: Record<InvestmentActivity, string> = {
  dividend: "Dividend",
  interest: "Interest",
  reinvestment: "Reinvestment",
  buy: "Buy",
  sell: "Sell",
  fee: "Fee",
  transfer: "Transfer",
  other: "Other",
};

// Order matters: the first match wins.
// - "DIVIDEND REINVESTMENT" is a purchase made with a dividend, not income
//   (the dividend itself arrives as its own transaction).
// - Capital-gain distributions from funds count with dividends: both are
//   income the holding paid out. A retirement "distribution" on its own is a
//   withdrawal, so only the capital-gain wording matches here.
// - Fees before buys and sells: "COMMISSION ON BUY" is a fee.
const PATTERNS: [InvestmentActivity, RegExp][] = [
  ["reinvestment", /reinvest|\bdrip\b/i],
  ["dividend", /dividend|\bdiv\b|cap(ital)?\.? ?gains?|\bltcg\b|\bstcg\b/i],
  ["interest", /interest|\bint\b/i],
  ["fee", /\bfees?\b|commission|advisory|management charge/i],
  ["sell", /\bsell\b|\bsold\b|\bsale\b|redemption|redeemed/i],
  ["buy", /\bbuy\b|\bbought\b|purchase/i],
  ["transfer", /transfer|deposit|withdraw|contribution|\bach\b|journal|rollover|distribution|wire|\bfunds?\b/i],
];

export function investmentActivity(description: string): InvestmentActivity {
  for (const [activity, pattern] of PATTERNS) if (pattern.test(description)) return activity;
  return "other";
}

/** Dividends and interest: what the holdings paid out. Only money in counts (a negative "dividend" is a correction). */
export function isInvestmentIncome(activity: InvestmentActivity, amountCents: number): boolean {
  return (activity === "dividend" || activity === "interest") && amountCents > 0;
}
