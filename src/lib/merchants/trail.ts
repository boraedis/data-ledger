import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { commandLog, merchantAliases, merchants, transactions, type RowChange } from "@/db/schema";
import type { Db } from "@/db/types";
import { explainMerchant } from "@/lib/categorize/merchant";

// How one transaction's merchant got to be what it is (#290), from the
// command log: when it arrived, and every applied change since that moved
// its cleaned name or its merchant (a re-run, a merge, a split, a hand
// fix). Not an operation, so it never becomes one of Tally's tools: this is
// for the owner tracing a surprising merchant, and nothing here goes to a
// model. Undone commands and the undos are left out, as in Activity's
// "who set this".

export type MerchantStep = {
  commandId: string;
  operation: string;
  actor: string;
  reason: string;
  at: Date;
  fromName: string | null;
  toName: string | null;
  /** The merchant each side was linked to: its current name, or null if it's gone (merged away). */
  from: { id: string; name: string | null } | null;
  to: { id: string; name: string | null } | null;
};

const field = (row: Record<string, unknown> | null, key: string) => (row && typeof row[key] === "string" ? (row[key] as string) : null);

/** Changes to the merchant in a list of row changes, for one transaction or all. */
export function merchantChanges(changes: RowChange[], transactionId?: string) {
  return changes.flatMap((c) => {
    if (c.table !== "transactions" || (transactionId && c.id !== transactionId) || !c.after) return [];
    const [fromName, toName] = [field(c.before, "merchant"), field(c.after, "merchant")];
    const [fromId, toId] = [field(c.before, "merchant_id"), field(c.after, "merchant_id")];
    if (c.before && fromName === toName && fromId === toId) return [];
    if (!c.before && !toId && !toName) return [];
    return [{ transactionId: c.id, fromName, toName, fromId, toId }];
  });
}

export async function merchantTrail(db: Db, transactionId: string): Promise<MerchantStep[]> {
  const rows = await db
    .select({ id: commandLog.id, operation: commandLog.operation, actor: commandLog.actor, reason: commandLog.reason, at: commandLog.createdAt, changes: commandLog.changes })
    .from(commandLog)
    .where(
      and(
        sql`${commandLog.status} = 'applied'`,
        isNull(commandLog.undoOf),
        isNull(commandLog.undoneBy),
        sql`${commandLog.changes} @> ${JSON.stringify([{ table: "transactions", id: transactionId }])}::jsonb`,
      ),
    )
    .orderBy(asc(commandLog.createdAt));
  const steps = rows.flatMap((r) => merchantChanges(r.changes, transactionId).map((c) => ({ ...c, command: r })));
  const ids = [...new Set(steps.flatMap((s) => [s.fromId, s.toId]).filter((x): x is string => !!x))];
  const names = new Map(
    ids.length ? (await db.select({ id: merchants.id, name: merchants.name }).from(merchants).where(inArray(merchants.id, ids))).map((m) => [m.id, m.name]) : [],
  );
  const side = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
  return steps.map((s) => ({
    commandId: s.command.id,
    operation: s.command.operation,
    actor: s.command.actor,
    reason: s.command.reason,
    at: s.command.at,
    fromName: s.fromName,
    toName: s.toName,
    from: side(s.fromId),
    to: side(s.toId),
  }));
}

/**
 * Everything the transaction page shows about its merchant (#290): how the
 * name is made from the raw fields today, the alias that name matched and
 * its merchant, whether the owner pinned it, and the trail. When the stored
 * name differs from what cleaning gives now, the cleanup has changed since
 * (#288's re-run would update it) or the owner chose it by hand.
 */
export async function merchantExplanation(db: Db, transactionId: string) {
  const [row] = await db
    .select({
      description: transactions.description,
      payee: transactions.payee,
      merchant: transactions.merchant,
      merchantId: transactions.merchantId,
      pinned: transactions.merchantPinned,
      merchantName: merchants.name,
    })
    .from(transactions)
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(eq(transactions.id, transactionId));
  if (!row) return null;
  const [alias] = row.merchant
    ? await db.select({ merchantId: merchantAliases.merchantId }).from(merchantAliases).where(eq(merchantAliases.alias, row.merchant))
    : [];
  return {
    explanation: explainMerchant(row.description, row.payee),
    stored: row.merchant,
    merchant: row.merchantId ? { id: row.merchantId, name: row.merchantName } : null,
    aliasMatched: !!alias && alias.merchantId === row.merchantId,
    pinned: row.pinned,
    trail: await merchantTrail(db, transactionId),
  };
}
