// Budget colours by pace (#159). Client-safe and pure.
//
// For a period still in progress, spending is compared with its pace: the
// budget times the share of the period elapsed (a straight line, as the
// month-end projection in #147 uses). A finished period has no pace; it is
// simply within its budget or over it.
//
// - within: at or under pace (or, finished, within budget) — green.
// - ahead: over pace but within budget — green to the pace line, yellow beyond.
// - over: over budget — yellow to the budget, red beyond, so the part that
//   was still within budget isn't lost in a solid red bar.
//
// Where a split won't fit (a year-grid square), one colour stands for the
// whole: green, yellow or red.

import { evenPace } from "@/lib/pace";

export type PaceTone = "within" | "ahead" | "over";
export type Colour = "green" | "yellow" | "red";
export type Segment = { colour: Colour; cents: number };

/** The pace at `share` of the way through a period; null once it's over (or not started). */
export function paceFor(budgetCents: number, share: number): number | null {
  return share > 0 && share < 1 ? evenPace(0, budgetCents, share) : null;
}

export function paceTone(spentCents: number, budgetCents: number, paceCents: number | null): PaceTone {
  if (spentCents > budgetCents) return "over";
  if (paceCents !== null && spentCents > paceCents) return "ahead";
  return "within";
}

/** One colour for a square too small to split. */
export const singleColour = (tone: PaceTone): Colour => (tone === "over" ? "red" : tone === "ahead" ? "yellow" : "green");

/** A bar's coloured runs, in order, adding up to what was spent (nothing for $0 or a net refund). */
export function paceSegments(spentCents: number, budgetCents: number, paceCents: number | null): Segment[] {
  if (spentCents <= 0) return [];
  const runs: Segment[] = (() => {
    switch (paceTone(spentCents, budgetCents, paceCents)) {
      case "over":
        return [
          { colour: "yellow", cents: Math.max(0, budgetCents) },
          { colour: "red", cents: spentCents - Math.max(0, budgetCents) },
        ];
      case "ahead":
        return [
          { colour: "green", cents: paceCents! },
          { colour: "yellow", cents: spentCents - paceCents! },
        ];
      default:
        return [{ colour: "green", cents: spentCents }];
    }
  })();
  return runs.filter((r) => r.cents > 0);
}
