import { count, eq, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { generateSeed } from "@/lib/seed/generate";

const { accounts, categories, transactions } = schema;

export class RealDataPresentError extends Error {}

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

    // Deleting seed accounts cascades to their transactions.
    await tx.delete(accounts).where(eq(accounts.source, "seed"));
    await tx
      .insert(categories)
      .values(data.categories)
      .onConflictDoNothing({ target: [categories.parentId, categories.name] });

    const inserted = await tx
      .insert(accounts)
      .values(data.accounts.map(({ name, institution, type }) => ({ name, institution, type, source: "seed" as const })))
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

    return { accounts: data.accounts.length, transactions: rows.length };
  });
}
