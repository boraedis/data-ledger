import { and, eq, gte, sum } from "drizzle-orm";
import { connections, syncRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { connectorFor as defaultConnectorFor } from "@/lib/connectors";
import { MAX_WINDOW_DAYS } from "@/lib/connectors/simplefin";
import { ConnectorAuthError, type Connector } from "@/lib/connectors/types";
import { backfillMerchantsIfNeeded, runCategorization } from "@/lib/categorize/pipeline";
import { execute } from "@/operations/runtime";

// Runs one sync for one connection: checks the rate budget, fetches from
// the connector, applies the snapshot through the import operation, and
// records the attempt. Bookkeeping (sync_runs, connection status) is
// infrastructure and written directly; ledger data only ever changes via
// the operation.

const DAY_MS = 86_400_000;

// SimpleFIN Bridge expects ≤24 requests a day per access token and disables
// tokens that go well past it. Stop at 20, leaving headroom for retries and
// for clock skew between our count and theirs.
export const MAX_REQUESTS_PER_DAY = 20;

// Bridge recommends overlapping windows by ~5 days: late-posting
// transactions land with dates before the last sync.
export const OVERLAP_DAYS = 5;

export type SyncTrigger = "cron" | "manual" | "setup";

export function syncWindowStart(lastSuccessAt: Date | null, now: Date): Date {
  const earliest = now.getTime() - MAX_WINDOW_DAYS * DAY_MS;
  if (!lastSuccessAt) return new Date(earliest);
  return new Date(Math.max(earliest, lastSuccessAt.getTime() - OVERLAP_DAYS * DAY_MS));
}

const REASONS: Record<SyncTrigger, string> = {
  cron: "Nightly bank sync",
  manual: "Bank sync started from Settings",
  setup: "First sync after connecting",
};

export type SyncResult =
  | { status: "success" | "partial"; inserted: number; updated: number; removed: number; categorized: number }
  | { status: "failed" | "skipped"; error: string };

export async function syncConnection(
  db: Db,
  connectionId: string,
  {
    trigger,
    now = new Date(),
    connectorFor = defaultConnectorFor,
  }: { trigger: SyncTrigger; now?: Date; connectorFor?: (c: typeof connections.$inferSelect) => Connector },
): Promise<SyncResult> {
  const [connection] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const [{ value }] = await db
    .select({ value: sum(syncRuns.requests) })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), gte(syncRuns.startedAt, new Date(now.getTime() - DAY_MS))));
  const recentRequests = Number(value ?? 0);

  const since = syncWindowStart(connection.lastSuccessAt, now);
  const connector = connectorFor(connection);
  const needed = connector.requestsFor(since);
  if (recentRequests + needed > MAX_REQUESTS_PER_DAY) {
    const error = `Skipped: ${recentRequests} requests in the last 24 hours, and this sync needs ${needed} more (limit ${MAX_REQUESTS_PER_DAY}, to stay inside SimpleFIN's quota).`;
    await db.insert(syncRuns).values({ connectionId, trigger, status: "skipped", startedAt: now, finishedAt: now, error });
    return { status: "skipped", error };
  }

  // Counted up front: if the fetch fails partway, those requests were
  // still spent against the provider's quota.
  const [run] = await db
    .insert(syncRuns)
    .values({ connectionId, trigger, status: "running", startedAt: now, requests: needed })
    .returning({ id: syncRuns.id });

  try {
    const snapshot = await connector.fetch(since);
    const result = await execute(db, {
      operation: "import.applySnapshot",
      actor: "import",
      reason: REASONS[trigger],
      input: {
        connectionId,
        windowStart: since.toISOString().slice(0, 10),
        snapshotOn: now.toISOString().slice(0, 10),
        accounts: snapshot.accounts.map((a) => ({ ...a, balanceAt: a.balanceAt.toISOString() })),
        transactions: snapshot.transactions,
      },
    });
    if (result.status !== "applied") throw new Error(`Import was ${result.status}, expected applied`);
    const counts = result.output as { inserted: number; updated: number; removed: number };

    // Categorize what just arrived with rules and memory. The model isn't
    // part of a sync — it runs from its own cron a few minutes later
    // (/api/cron/classify), after the sync has woken it. A failure here
    // must not fail the sync: the data is in, and the rest waits in the inbox.
    let categorized = 0;
    const messages = [...snapshot.messages];
    try {
      await backfillMerchantsIfNeeded(db);
      const result = await runCategorization(db);
      categorized = result.byRules + result.byMemory;
    } catch (error) {
      console.error("Categorization after sync failed", error);
      messages.push({ code: "app.categorize", message: "Automatic categorization failed this time; new transactions are in the inbox." });
    }

    // Provider messages (an institution needing re-auth, a rate warning)
    // don't fail the sync — everything else still came through — but they
    // mark it partial so health surfaces them.
    const status = messages.length ? "partial" : "success";
    await db
      .update(syncRuns)
      .set({
        status,
        finishedAt: new Date(),
        requests: snapshot.requests,
        messages,
        commandId: result.commandId,
        inserted: counts.inserted,
        updated: counts.updated,
        removed: counts.removed,
      })
      .where(eq(syncRuns.id, run.id));
    await db
      .update(connections)
      .set({ status: "active", lastSuccessAt: now, lastError: null })
      .where(eq(connections.id, connectionId));
    return { status, inserted: counts.inserted, updated: counts.updated, removed: counts.removed, categorized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(syncRuns).set({ status: "failed", finishedAt: new Date(), error: message }).where(eq(syncRuns.id, run.id));
    // Only a rejected credential breaks the connection; a timeout or a 500
    // is just a failed night, retried tomorrow.
    await db
      .update(connections)
      .set({ lastError: message, ...(error instanceof ConnectorAuthError ? { status: "broken" as const } : {}) })
      .where(eq(connections.id, connectionId));
    return { status: "failed", error: message };
  }
}

export async function syncAllConnections(db: Db, trigger: SyncTrigger) {
  const all = await db.select({ id: connections.id }).from(connections);
  const results: Record<string, SyncResult> = {};
  // Sequential: a handful of connections at most, and one at a time keeps
  // the database pool to a single connection.
  for (const { id } of all) results[id] = await syncConnection(db, id, { trigger });
  return results;
}
