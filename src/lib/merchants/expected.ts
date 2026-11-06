import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";

// Which transactions are some merchant's business (#349). The aim is for
// every row to have a merchant and every merchant a type (#333), but some
// rows have no merchant by nature, and nagging about them is noise:
// - $0 rows (a card verification, a zero-dollar statement line);
// - transfers, paired or filed under a transfer category, which are the
//   owner's own money moving;
// - anything in a brokerage or retirement account: buys, sells, dividends
//   and sweeps, which Trades describes instead (#321).
// The same test runs in SQL (filters) and on a listed row (the chip), so
// the tag and the filter always agree.

/** In SQL, on `transactions`: the row needs a merchant. */
export function merchantExpectedSql(db: Db): SQL {
  return and(
    ne(transactions.amountCents, 0),
    isNull(transactions.transferPairId),
    or(isNull(transactions.categoryId), notInArray(transactions.categoryId, db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "transfer")))),
    notInArray(transactions.accountId, db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.type, [...INVESTMENT_KINDS]))),
  )!;
}

/** The same, on a row already read. */
export const merchantExpected = (row: { amountCents: number; transfer: boolean; transferCategory: boolean; investmentAccount: boolean }) =>
  row.amountCents !== 0 && !row.transfer && !row.transferCategory && !row.investmentAccount;

/**
 * Merchants made only of rows that need none: built from transfers,
 * brokerage rows or $0 rows. They're left off the Merchants page and out
 * of type suggestions. A merchant with no rows at all (just made, or
 * every row moved away) isn't one: it may be about to get some.
 */
export async function merchantsOutOfScope(db: Db): Promise<Set<string>> {
  const [linked, expected] = await Promise.all([
    db.selectDistinct({ id: transactions.merchantId }).from(transactions).where(isNotNull(transactions.merchantId)),
    db.selectDistinct({ id: transactions.merchantId }).from(transactions).where(and(isNotNull(transactions.merchantId), merchantExpectedSql(db))),
  ]);
  const keep = new Set(expected.map((r) => r.id));
  return new Set(linked.map((r) => r.id!).filter((id) => !keep.has(id)));
}
