// When a transaction the owner added by hand (#64) shows up in the bank's
// feed too. Pure, so the rule is tested without a database;
// src/operations/manual.ts and countsAsSpending() apply it.
//
// Like provisional matching (#30), it can't lean on the text: "Dinner with
// Alex" and "SQ *LUMEN BISTRO" are the same purchase. It uses what both
// agree on, the account and the exact amount, and a window around the
// date the owner typed. Unlike provisional matching nothing merges on its
// own: the owner typed this one, and two identical $20 payments in a week
// are as likely as one, so the owner decides.

// Wider than an alert's window: a typed date can be a day or two off, and a
// cheque or a payment-app transfer can take a week to reach the bank.
export const DAYS_BEFORE = 3;
export const DAYS_AFTER = 7;

const DAY_MS = 86_400_000;
const offset = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

export type Row = { id: string; accountId: string; amountCents: number; postedOn: string; merchant: string | null };

/** Whether a bank transaction could be the same purchase as a manual one. */
export function couldBeSame(manual: Row, bank: Row): boolean {
  if (manual.id === bank.id || manual.accountId !== bank.accountId || manual.amountCents !== bank.amountCents) return false;
  const days = offset(manual.postedOn, bank.postedOn);
  return days >= -DAYS_BEFORE && days <= DAYS_AFTER;
}

/** The bank transactions that could be this manual one, likeliest first: the same merchant, then the closest date. */
export function candidates<T extends Row>(manual: Row, bank: T[]): T[] {
  return bank
    .filter((b) => couldBeSame(manual, b))
    .sort(
      (a, b) =>
        Number(b.merchant !== null && b.merchant === manual.merchant) - Number(a.merchant !== null && a.merchant === manual.merchant) ||
        Math.abs(offset(manual.postedOn, a.postedOn)) - Math.abs(offset(manual.postedOn, b.postedOn)) ||
        a.postedOn.localeCompare(b.postedOn),
    );
}
