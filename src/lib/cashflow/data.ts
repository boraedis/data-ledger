import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { AccountKind } from "@/lib/account-kinds";
import type { AccountGroup, AccountInfo, Paycheck, Transfer } from "@/lib/cashflow/graph";
import type { Lookup, SpendLine } from "@/lib/spending/analyze";
import { budgetAccountIds, listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { listPayStubs } from "@/operations/pay";
import { read } from "@/operations/runtime";
import { countsAsSpending, reimbursementAdjustments, spendingLines } from "@/operations/transactions";

// The inputs to a period's cash flow (#62), from the records Budgets and
// Spending already read, so the pages agree:
// - paychecks: pay stubs dated in the period whose deposits are linked and
//   add up to the net; they stand in for those deposits
// - lines: transactions.spendingLines (net, or gross on request), less the
//   stub-linked deposits
// - transfers: money between the owner's own accounts, by its pair, a
//   transfer category, or an uncategorized outflow met by the same amount
//   arriving in another account
// - uncategorized: the rest of what's not filed yet, so the diagram adds up
//
// Not an operation: one page's assembly of reads that already exist, and
// nothing here goes to the model.

const DAY_MS = 86_400_000;
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * DAY_MS).toISOString().slice(0, 10);
// How far apart the two sides of a transfer can post (a card payment
// often lands a day or more after it leaves checking).
const TRANSFER_DAYS = 5;

const GROUP: Record<AccountKind, AccountGroup> = {
  checking: "spending",
  payment_app: "spending",
  savings: "savings",
  brokerage: "investment",
  retirement: "investment",
  other_asset: "investment",
  credit: "debt",
  loan: "debt",
};

export async function cashFlowInputs(db: Db, { from, to, gross }: { from: string; to: string; gross: boolean }) {
  const [stubs, rawLines, cats, accts] = await Promise.all([
    read(db, listPayStubs, {}),
    read(db, spendingLines, { from, to, budgetOnly: true, gross }),
    read(db, listCategories, {}),
    read(db, listAccounts, {}),
  ]);
  const lookup: Lookup = { categories: new Map(cats.map((c) => [c.id, c])), accountNames: new Map(accts.map((a) => [a.id, a.name])) };
  const accounts = new Map<string, AccountInfo>(accts.map((a) => [a.id, { name: a.name, group: GROUP[a.kind] ?? "spending" }]));

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

  const { transfers, consumed } = await transfersIn(db, from, to);
  const uncategorized = await uncategorizedIn(db, from, to, new Set([...consumed, ...stubDeposits]), gross);
  const uncategorizedOut = uncategorized.filter((u) => u.amountCents < 0);
  return {
    paychecks,
    lines,
    transfers,
    uncategorized,
    accounts,
    lookup,
    uncategorizedOut: { count: uncategorizedOut.length, cents: -uncategorizedOut.reduce((s, u) => s + u.amountCents, 0) },
  };
}

/**
 * Money that moved between the owner's own accounts in the period: a
 * matched pair (#24); money out under a transfer category, met with the
 * same amount into another account within a few days if there is one; or
 * an uncategorized outflow that does meet one. A transfer-category inflow
 * nothing matched is the other half missing on the way in. `consumed` is
 * every transaction a transfer accounts for.
 */
async function transfersIn(db: Db, from: string, to: string): Promise<{ transfers: Transfer[]; consumed: Set<string> }> {
  const transferCategories = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.kind, "transfer"));
  const isTransfer = new Set(transferCategories.map((c) => c.id));
  const label = new Map(transferCategories.map((c) => [c.id, c.name]));
  const select = {
    id: transactions.id,
    accountId: transactions.accountId,
    amountCents: transactions.amountCents,
    postedOn: transactions.postedOn,
    categoryId: transactions.categoryId,
    transferPairId: transactions.transferPairId,
    isSplit: transactions.isSplit,
  };
  const settled = and(eq(transactions.pending, false), isNull(transactions.provisionalSource));
  const rows = await db
    .select(select)
    .from(transactions)
    .where(and(settled, gte(transactions.postedOn, shift(from, -TRANSFER_DAYS)), lte(transactions.postedOn, shift(to, TRANSFER_DAYS))));
  const inPeriod = (on: string) => on >= from && on <= to;
  const candidate = (r: (typeof rows)[number]) => !r.isSplit && (r.categoryId === null || isTransfer.has(r.categoryId));
  const outflows = rows.filter((r) => r.amountCents < 0 && inPeriod(r.postedOn) && (r.transferPairId || candidate(r)));
  const inflows = rows.filter((r) => r.amountCents > 0 && !r.transferPairId && candidate(r));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set<string>();
  const consumed = new Set<string>();
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
  const transfers: Transfer[] = [];

  for (const o of outflows.sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id))) {
    const name = (o.categoryId && label.get(o.categoryId)) || "Transfer";
    const amountCents = -o.amountCents;
    if (o.transferPairId) {
      const pair = byId.get(o.transferPairId);
      transfers.push({ fromAccountId: o.accountId, toAccountId: pair?.accountId ?? null, label: name, amountCents, transactionId: o.id });
      consumed.add(o.id).add(o.transferPairId);
      continue;
    }
    const match = inflows
      .filter((i) => !used.has(i.id) && i.accountId !== o.accountId && i.amountCents === amountCents && days(i.postedOn, o.postedOn) <= TRANSFER_DAYS)
      .sort((a, b) => days(a.postedOn, o.postedOn) - days(b.postedOn, o.postedOn))[0];
    if (match) {
      used.add(match.id);
      consumed.add(o.id).add(match.id);
      transfers.push({ fromAccountId: o.accountId, toAccountId: match.accountId, label: name, amountCents, transactionId: o.id });
    } else if (o.categoryId) {
      // Filed as a transfer, other half not found: still not spending.
      consumed.add(o.id);
      transfers.push({ fromAccountId: o.accountId, toAccountId: null, label: name, amountCents, transactionId: o.id });
    }
    // Uncategorized with no match: just uncategorized money out.
  }
  for (const i of inflows) {
    if (used.has(i.id) || !i.categoryId || !inPeriod(i.postedOn)) continue;
    consumed.add(i.id);
    transfers.push({ fromAccountId: null, toAccountId: i.accountId, label: label.get(i.categoryId)!, amountCents: i.amountCents, transactionId: i.id });
  }
  return { transfers, consumed };
}

/**
 * Money in and out of budget accounts with no category yet, that no
 * transfer accounts for. A payment matched to what friends owe counts only
 * its unmatched part, as in net spending (the matched part isn't income).
 */
async function uncategorizedIn(db: Db, from: string, to: string, consumed: Set<string>, gross: boolean) {
  const effective = sql<string>`coalesce(${transactions.experiencedOn}, ${transactions.postedOn})`;
  const rows = await db
    .select({ transactionId: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        isNull(transactions.categoryId),
        eq(transactions.isSplit, false),
        isNull(transactions.transferPairId),
        sql`${effective} >= ${from}`,
        sql`${effective} <= ${to}`,
        inArray(transactions.accountId, budgetAccountIds(db)),
        countsAsSpending(),
      ),
    );
  const open = rows.filter((r) => !consumed.has(r.transactionId));
  if (gross) return open;
  const { matched } = await reimbursementAdjustments(db, open.filter((r) => r.amountCents > 0).map((r) => r.transactionId));
  return open.map((r) => ({ ...r, amountCents: r.amountCents > 0 ? r.amountCents - (matched.get(r.transactionId) ?? 0) : r.amountCents })).filter((r) => r.amountCents !== 0);
}
