import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { merchantOverview, spendByMonth } from "@/lib/merchants/overview";
import { defineRead } from "@/operations/define";
import { listMerchants } from "@/operations/merchants";
import { listRecurring } from "@/operations/recurring";
import { NotFoundError } from "@/operations/tracked";
import { spendingLines } from "@/operations/transactions";

// What the Merchants pages read (#286). A file of its own because these
// build on the transactions and recurring reads, and those operations
// import merchants.ts to link new transactions: kept apart, there's no cycle.
// Spending is spendingLines' (the lines Spending and Budgets count, net
// unless gross), over all of history, so the totals agree with those pages.
// Merchant names, amounts and dates only: no account numbers or balances.

const MONTHS = 12;
const RECENT = 100;
const DESCRIPTORS = 20;

const categoryLookup = async (db: Db) => {
  const rows = await db.select({ id: categories.id, name: categories.name, kind: categories.kind }).from(categories);
  const byId = new Map(rows.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
};

export const merchantOverviewRead = defineRead({
  name: "merchants.overview",
  description:
    "Every merchant with its type, aliases, total net spend (gross if asked) over all history, number of transactions, " +
    "last seen date, usual category and whether it has a recurring charge. Totals are the lines Spending and Budgets count.",
  input: z.object({ gross: z.boolean().default(false) }),
  run: async (db, { gross }) => {
    const [merchants, txns, lines, category, recurring] = await Promise.all([
      listMerchants.run(db, {}),
      db
        .select({ id: transactions.id, merchantId: transactions.merchantId, postedOn: transactions.postedOn })
        .from(transactions)
        .where(isNotNull(transactions.merchantId)),
      spendingLines.run(db, { budgetOnly: true, gross }),
      categoryLookup(db),
      listRecurring.run(db, {}),
    ]);
    return merchantOverview({
      merchants: merchants.map((m) => ({ id: m.id, name: m.name, typeId: m.typeId, type: m.type, aliases: m.aliases.map((a) => a.alias) })),
      txns: txns.map((t) => ({ id: t.id, merchantId: t.merchantId!, postedOn: t.postedOn })),
      lines,
      category,
      recurring: new Set(recurring.filter((r) => r.status !== "dismissed").map((r) => r.merchant)),
    });
  },
});

const lastMonths = (today: string) =>
  Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - (MONTHS - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });

export const merchantDetail = defineRead({
  name: "merchants.detail",
  description:
    "One merchant: its type, its aliases (cleaned names) with how many transactions each has, the raw bank " +
    "descriptions seen for it, net spend by month for the last 12 months and in all, and its latest transactions.",
  input: z.object({ merchantId: z.uuid(), gross: z.boolean().default(false), today: z.iso.date().optional() }),
  run: async (db, { merchantId, gross, today = new Date().toISOString().slice(0, 10) }) => {
    const all = await listMerchants.run(db, {});
    const merchant = all.find((m) => m.id === merchantId);
    if (!merchant) throw new NotFoundError("Merchant not found");
    const mine = eq(transactions.merchantId, merchantId);
    const [ids, byAlias, descriptors, recent, category] = await Promise.all([
      db.select({ id: transactions.id }).from(transactions).where(mine),
      db
        .select({ alias: transactions.merchant, n: count() })
        .from(transactions)
        .where(and(mine, isNotNull(transactions.merchant)))
        .groupBy(transactions.merchant),
      db
        .select({ description: transactions.description, n: count() })
        .from(transactions)
        .where(mine)
        .groupBy(transactions.description)
        .orderBy(desc(count()), transactions.description)
        .limit(DESCRIPTORS),
      db
        .select({
          id: transactions.id,
          postedOn: transactions.postedOn,
          description: transactions.description,
          amountCents: transactions.amountCents,
          accountName: accounts.name,
          accountDisplayName: accounts.displayName,
          categoryId: transactions.categoryId,
          isSplit: transactions.isSplit,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(mine)
        .orderBy(desc(transactions.postedOn), desc(transactions.createdAt))
        .limit(RECENT),
      categoryLookup(db),
    ]);
    const idSet = new Set(ids.map((t) => t.id));
    const lines = (await spendingLines.run(db, { budgetOnly: true, gross })).filter((l) => idSet.has(l.transactionId));
    const isSpend = (id: string) => category(id)?.kind === "expense";
    const n = new Map(byAlias.map((a) => [a.alias, a.n]));
    return {
      ...merchant,
      aliases: merchant.aliases.map((a) => ({ ...a, transactions: n.get(a.alias) ?? 0 })),
      descriptors,
      months: spendByMonth(lines, lastMonths(today), isSpend),
      spentCents: lines.filter((l) => isSpend(l.categoryId)).reduce((s, l) => s - l.amountCents, 0),
      recent: recent.map(({ accountDisplayName, accountName, categoryId, ...t }) => ({
        ...t,
        accountName: accountDisplayName ?? accountName,
        category: t.isSplit ? "Split" : categoryId ? (category(categoryId)?.name ?? null) : null,
      })),
    };
  },
});
