import { MASKED_AMOUNT } from "@/lib/money";
import { privacyOn } from "@/lib/privacy/state";

// Proportions in privacy mode (#366, epic #358): with amounts masked, the
// views where the shape is the point show percentages instead, each of one
// base the page names. Net worth over time and its breakdown: of today's
// net worth, which is 100%. Budgets: of the target. Spending: of the
// period's spending. Cash flow: of income. Figures from the same totals the
// page already shows; only what's displayed changes.

/** Whether the key views show proportions: privacy mode, by the formatter's rules (lib/privacy/state.ts). */
export const showProportions = () => privacyOn();

const MINUS = "−";
const number = (pct: number) => {
  const abs = Math.abs(pct);
  // One place under 10%, whole numbers above, as Cash flow's shares do.
  return abs < 10 ? abs.toFixed(1).replace(/\.0$/, "") : String(Math.round(abs));
};

/**
 * `cents` as a percent of `base`: "84.2%", "100%", "−5%". A base of zero or
 * less has no proportions (a net worth below zero), so it stays masked.
 */
export function percentOf(cents: number, base: number): string {
  if (!(base > 0)) return MASKED_AMOUNT;
  const pct = (cents / base) * 100;
  return `${pct < 0 && number(pct) !== "0" ? MINUS : ""}${number(pct)}%`;
}

/** A change, in points of `base`: "+3.1 pts", "−12 pts". */
export function pointsOf(change: number, base: number): string {
  if (!(base > 0)) return MASKED_AMOUNT;
  const pct = (change / base) * 100;
  const n = number(pct);
  return `${n === "0" ? "" : pct < 0 ? MINUS : "+"}${n} pts`;
}
