import { count, eq, inArray, ne, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { generateSeed } from "@/lib/seed/generate";

const { accounts, balanceSnapshots, categories, holdingSnapshots, payStubDeposits, payStubLines, payStubs, transactions } = schema;

export class RealDataPresentError extends Error {}

// The seed's merchants as rows (#285), the way the merchants migration
// backfills a real database: one per cleaned name, each name its alias, and
// every transaction linked. Plain SQL, like the rest of the seed: it isn't
// an operation and isn't logged.
async function linkSeedMerchants(tx: Pick<Db, "execute">) {
  await tx.execute(sql`
    insert into merchants (name)
    select mode() within group (order by merchant) from transactions where merchant is not null and merchant <> '' group by lower(merchant)
    on conflict do nothing`);
  await tx.execute(sql`
    insert into merchant_aliases (alias, merchant_id)
    select distinct t.merchant, m.id from transactions t join merchants m on lower(m.name) = lower(t.merchant)
    where t.merchant is not null and t.merchant <> ''
    on conflict do nothing`);
  await tx.execute(sql`
    update transactions t set merchant_id = a.merchant_id from merchant_aliases a
    where a.alias = t.merchant and t.merchant_id is null`);
}

/**
 * Replaces the synthetic data in `db` with a fresh copy. Refuses outright if
 * the database holds any account that didn't come from the seed — the guard
 * that makes it safe to run against the wrong DATABASE_URL by mistake. It
 * never deletes or touches non-seed rows.
 */
export async function applySeed(db: Db, { endDate = new Date() }: { endDate?: Date } = {}) {
  // One transaction, so the guard's answer still holds when the deletes run
  // and a failure halfway leaves the previous seed intact.
  return db.transaction(async (tx) => {
    const [{ value: realAccounts }] = await tx
      .select({ value: count() })
      .from(accounts)
      .where(ne(accounts.source, "seed"));
    if (realAccounts > 0) {
      throw new RealDataPresentError(
        `Refusing to seed: this database has ${realAccounts} non-synthetic account(s). Seed data only goes into local and preview databases.`,
      );
    }

    const data = generateSeed({ endDate });

    // The previous seed's pay stubs go with their deposits (their lines
    // cascade). Pay stubs not linked to a seed deposit are left alone.
    const seedDeposits = tx
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(eq(accounts.source, "seed"));
    const seedStubs = tx.select({ id: payStubDeposits.payStubId }).from(payStubDeposits).where(inArray(payStubDeposits.transactionId, seedDeposits));
    await tx.delete(payStubs).where(inArray(payStubs.id, seedStubs));
    // Deleting seed accounts cascades to their transactions.
    await tx.delete(accounts).where(eq(accounts.source, "seed"));
    await tx
      .insert(categories)
      .values(data.categories)
      .onConflictDoNothing({ target: [categories.parentId, categories.name] });

    const inserted = await tx
      .insert(accounts)
      .values(
        data.accounts.map(({ key, name, institution, type }) => {
          const last = data.snapshots.findLast((s) => s.accountKey === key);
          return {
            name,
            institution,
            type,
            source: "seed" as const,
            countsTowardBudgets: schema.countsTowardBudgetsByDefault(type),
            balanceCents: last?.balanceCents ?? null,
            balanceAt: last ? new Date(`${last.on}T12:00:00Z`) : null,
          };
        }),
      )
      .returning({ id: accounts.id, name: accounts.name });
    const idByKey = new Map(
      data.accounts.map((a) => [a.key, inserted.find((row) => row.name === a.name)!.id]),
    );

    // Chunked to stay well under Postgres's 65,535 bind-parameter limit.
    const rows = data.transactions.map(({ accountKey, ...t }) => ({
      ...t,
      accountId: idByKey.get(accountKey)!,
      merchant: normalizeMerchant(t.description),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(transactions).values(rows.slice(i, i + 500));
    }
    await linkSeedMerchants(tx);

    const depositIds = new Map(
      (await tx.select({ id: transactions.id, externalId: transactions.externalId }).from(transactions).where(inArray(transactions.externalId, data.payStubs.map((p) => p.depositExternalId)))).map((t) => [t.externalId, t.id]),
    );
    for (const { depositExternalId, lines, ...stub } of data.payStubs) {
      const [row] = await tx.insert(payStubs).values(stub).returning({ id: payStubs.id });
      const depositId = depositIds.get(depositExternalId);
      if (depositId) await tx.insert(payStubDeposits).values({ payStubId: row.id, transactionId: depositId });
      await tx.insert(payStubLines).values(lines.map((l, position) => ({ ...l, payStubId: row.id, position })));
    }

    const snapshots = data.snapshots.map(({ accountKey, ...s }) => ({ ...s, accountId: idByKey.get(accountKey)! }));
    for (let i = 0; i < snapshots.length; i += 500) {
      await tx.insert(balanceSnapshots).values(snapshots.slice(i, i + 500));
    }

    const holdings = data.holdings.map(({ accountKey, ...h }) => ({ ...h, accountId: idByKey.get(accountKey)! }));
    for (let i = 0; i < holdings.length; i += 500) {
      await tx.insert(holdingSnapshots).values(holdings.slice(i, i + 500));
    }

    return { accounts: data.accounts.length, transactions: rows.length, snapshots: snapshots.length, holdings: holdings.length };
  });
}
