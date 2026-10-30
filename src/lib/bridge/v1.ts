import { z } from "zod";
import { categories } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Cadence } from "@/lib/recurring/detect";
import { listRecurring } from "@/operations/recurring";
import { spendingLines } from "@/operations/transactions";

// Version 1 of the Diary bridge (#12): what Data Diary may read, and
// nothing else. Every field below is chosen here, by name. Nothing passes
// an internal query's rows through, so a column added to a table or an
// operation later can't leak out by accident. Changing a shape means a v2,
// never an edit here; the contract is docs/bridge-v1.md.
//
// Aggregates only: no transaction ids, descriptions, accounts or balances.
// The Diary side can chart spending and know about bills; it can't
// reconstruct the ledger.

export const VERSION = "v1";

// A little over a year per request: enough for "this year vs last" charts
// in a couple of calls, small enough that one request stays cheap.
export const MAX_RANGE_DAYS = 400;

export const dailySpendQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, { message: "from must be on or before to" })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_RANGE_DAYS, {
    message: `At most ${MAX_RANGE_DAYS} days per request`,
  });

export type DailySpendRow = {
  date: string;
  categoryId: string;
  category: string;
  parentCategory: string | null;
  spentCents: number;
};

/**
 * Net spend per day per expense category, from/to inclusive, in accounts
 * that count toward budgets. The same numbers Budgets uses
 * (transactions.spendingLines): experience date when set, splits in their
 * parts, your share only of shared expenses. Refunds reduce a day's spend,
 * so a day can be negative; days with nothing are left out. Income,
 * transfers and uncategorized transactions aren't spend.
 */
export async function dailySpend(db: Db, query: z.infer<typeof dailySpendQuery>): Promise<DailySpendRow[]> {
  const [lines, cats] = await Promise.all([
    spendingLines.run(db, { from: query.from, to: query.to, budgetOnly: true, gross: false }),
    db.select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId }).from(categories),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (byId.get(line.categoryId)?.kind !== "expense") continue;
    const key = `${line.date}|${line.categoryId}`;
    totals.set(key, (totals.get(key) ?? 0) - line.amountCents);
  }
  return [...totals]
    .filter(([, cents]) => cents !== 0)
    .map(([key, spentCents]) => {
      const [date, categoryId] = key.split("|");
      const category = byId.get(categoryId)!;
      return {
        date,
        categoryId,
        category: category.name,
        parentCategory: category.parentId ? (byId.get(category.parentId)?.name ?? null) : null,
        spentCents,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));
}

// Stable codes for the contract. The ledger's own cadence names are
// display text ("every 2 weeks") and may be reworded; these may not.
const CADENCE_CODES: Record<Cadence["name"], string> = {
  weekly: "weekly",
  "every 2 weeks": "biweekly",
  monthly: "monthly",
  quarterly: "quarterly",
  "twice a year": "semiannual",
  annual: "annual",
};

export type RecurringRow = {
  merchant: string;
  status: "confirmed" | "suggested";
  cadence: string;
  typicalCents: number;
  latestCents: number;
  variable: boolean;
  lastOn: string;
  nextExpectedOn: string;
  annualizedCents: number;
  active: boolean;
};

/**
 * Recurring charges as of a day: what's billed, how often, about how much
 * and when next. Ones the owner dismissed as not recurring, or cancelled,
 * are left out.
 * The account a charge is billed to isn't included; the same merchant on
 * two cards is two rows.
 */
export async function recurringCharges(db: Db, on: string): Promise<RecurringRow[]> {
  const series = await listRecurring.run(db, { on });
  return series
    .filter((s): s is typeof s & { status: "confirmed" | "suggested" } => s.status === "confirmed" || s.status === "suggested")
    .map((s) => ({
      merchant: s.merchant,
      status: s.status,
      cadence: CADENCE_CODES[s.cadence],
      typicalCents: s.typicalCents,
      latestCents: s.latestCents,
      variable: s.variable,
      lastOn: s.lastOn,
      nextExpectedOn: s.nextExpectedOn,
      annualizedCents: s.annualizedCents,
      active: s.active,
    }))
    .sort((a, b) => a.merchant.localeCompare(b.merchant));
}
