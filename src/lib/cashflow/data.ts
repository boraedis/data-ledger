import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Paycheck, Transfer } from "@/lib/cashflow/graph";
import type { Lookup, SpendLine } from "@/lib/spending/analyze";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { listPayStubs } from "@/operations/pay";
import { read } from "@/operations/runtime";
import { spendingLines, uncategorizedSpend } from "@/operations/transactions";

// The inputs to a period's cash flow (#62), from the records Budgets and
// Spending already read, so the three pages agree:
// - paychecks: pay stubs dated in the period whose deposits are linked and
//   add up to the net; they stand in for those deposits
// - lines: transactions.spendingLines (net, or gross on request), less the
//   stub-linked deposits
// - transfers: money between the owner's own accounts, by its pair or a
//   transfer category; never income or spending
//
// Not an operation: it's one page's assembly of reads that already exist,
// and nothing here goes to the model.

const DAY_MS = 86_400_000;
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * DAY_MS).toISOString().slice(0, 10);
// How far apart the two sides of a transfer can post (a card payment
// often lands a day or more after it leaves checking).
const TRANSFER_DAYS = 5;

export async function cashFlowInputs(db: Db, { from, to, gross }: { from: string; to: string; gross: boolean }) {
  const [stubs, rawLines, cats, accts, uncategorized] = await Promise.all([
    read(db, listPayStubs, {}),
    read(db, spendingLines, { from, to, budgetOnly: true, gross }),
    read(db, listCategories, {}),
    read(db, listAccounts, {}),
    read(db, uncategorizedSpend, { from, to }),
  ]);
  const lookup: Lookup = { categories: new Map(cats.map((c) => [c.id, c])), accountNames: new Map(accts.map((a) => [a.id, a.name])) };

  // Every stub-linked deposit is the paycheck's, wherever its stub is dated:
  // never counted again as a plain deposit.
  const stubDeposits = new Set(stubs.flatMap((s) => s.deposits.map((d) => d.id)));
  const paychecks: Paycheck[] = stubs
    .filter((s) => s.payDate >= from && s.payDate <= to && s.deposits.length && s.deposits.reduce((t, d) => t + d.amountCents, 0) === s.netCents)
    .map((s) => ({
      employer: s.employer,
      grossCents: s.grossCents,
      lines: s.lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents })),
      employerLines: s.employerLines.map((l) => ({ kind: l.kind, amountCents: l.amountCents })),
      deposits: s.deposits.map((d) => ({ accountId: d.accountId, amountCents: d.amountCents })),
    }));
  const lines: SpendLine[] = rawLines.filter((l) => !stubDeposits.has(l.transactionId));

  return { paychecks, lines, transfers: await transfersIn(db, from, to), lookup, uncategorized };
}

/**
 * Money that left one of the owner's accounts for another, in the period:
 * a matched pair (#24), or money out filed under a transfer category, met
 * with the same amount coming into another account within a few days.
 * Unmatched, it keeps its category's name so it isn't lost.
 */
async function transfersIn(db: Db, from: string, to: string): Promise<Transfer[]> {
  const transferCategories = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.kind, "transfer"));
  const transferIds = transferCategories.map((c) => c.id);
  const settled = and(eq(transactions.pending, false), isNull(transactions.provisionalSource));
  const select = {
    id: transactions.id,
    accountId: transactions.accountId,
    amountCents: transactions.amountCents,
    postedOn: transactions.postedOn,
    categoryId: transactions.categoryId,
    transferPairId: transactions.transferPairId,
  };
  const outflows = await db
    .select(select)
    .from(transactions)
    .where(
      and(
        settled,
        sql`${transactions.amountCents} < 0`,
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        sql`(${transactions.transferPairId} is not null${transferIds.length ? sql` or ${inArray(transactions.categoryId, transferIds)}` : sql``})`,
      ),
    );
  if (outflows.length === 0) return [];
  const pairIds = outflows.map((o) => o.transferPairId).filter((id): id is string => Boolean(id));
  const [pairs, inflows] = await Promise.all([
    pairIds.length ? db.select({ id: transactions.id, accountId: transactions.accountId }).from(transactions).where(inArray(transactions.id, pairIds)) : [],
    db
      .select(select)
      .from(transactions)
      .where(
        and(
          settled,
          sql`${transactions.amountCents} > 0`,
          gte(transactions.postedOn, shift(from, -TRANSFER_DAYS)),
          lte(transactions.postedOn, shift(to, TRANSFER_DAYS)),
          isNull(transactions.transferPairId),
          // The receiving side is uncategorized or itself a transfer; never income.
          sql`(${transactions.categoryId} is null${transferIds.length ? sql` or ${inArray(transactions.categoryId, transferIds)}` : sql``})`,
        ),
      ),
  ]);
  const pairAccount = new Map(pairs.map((p) => [p.id, p.accountId]));
  const label = new Map(transferCategories.map((c) => [c.id, c.name]));
  const used = new Set<string>();
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

  return outflows
    .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id))
    .map((o): Transfer => {
      const name = (o.categoryId && label.get(o.categoryId)) || "Transfer";
      const amountCents = -o.amountCents;
      if (o.transferPairId) return { fromAccountId: o.accountId, toAccountId: pairAccount.get(o.transferPairId) ?? null, label: name, amountCents, transactionId: o.id };
      const match = inflows
        .filter((i) => !used.has(i.id) && i.accountId !== o.accountId && i.amountCents === amountCents && days(i.postedOn, o.postedOn) <= TRANSFER_DAYS)
        .sort((a, b) => days(a.postedOn, o.postedOn) - days(b.postedOn, o.postedOn))[0];
      if (match) used.add(match.id);
      return { fromAccountId: o.accountId, toAccountId: match?.accountId ?? null, label: name, amountCents, transactionId: o.id };
    });
}
