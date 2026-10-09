import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { accounts, connections, syncRuns, type SyncMessage } from "@/db/schema";
import type { Db } from "@/db/types";

// What "is my bank data current?" looks like, per connection and per
// institution. Derived on read from connections, accounts and the latest
// sync run — no separate state to drift.

// Bridge refreshes daily; an institution not updated in this long has
// almost certainly stopped syncing, even if nothing reported an error.
export const STALE_AFTER_HOURS = 72;

export type InstitutionHealth = {
  institutionId: string;
  institution: string;
  lastUpdated: Date | null;
  stale: boolean;
  messages: SyncMessage[];
  accounts: { id: string; name: string; balanceCents: number | null; balanceAt: Date | null }[];
};

export type ConnectionHealth = {
  id: string;
  label: string;
  status: "active" | "broken";
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastRun: { status: string; startedAt: Date; error: string | null } | null;
  // Messages not tied to one institution (rate warnings, general errors).
  messages: SyncMessage[];
  institutions: InstitutionHealth[];
};

export async function getConnectionHealth(db: Db, now = new Date()): Promise<ConnectionHealth[]> {
  const conns = await db.select().from(connections).orderBy(connections.createdAt);
  const linked = await db.select().from(accounts).where(isNotNull(accounts.connectionId)).orderBy(accounts.name);

  return Promise.all(
    conns.map(async (c) => {
      const [lastRun] = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.connectionId, c.id))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      // Messages come from the last run that actually reached the provider,
      // so a skipped run (rate budget) doesn't hide the previous night's.
      const [lastFetch] = await db
        .select({ messages: syncRuns.messages })
        .from(syncRuns)
        .where(and(eq(syncRuns.connectionId, c.id), gt(syncRuns.requests, 0)))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      const messages = lastFetch?.messages ?? [];

      const byInstitution = new Map<string, InstitutionHealth>();
      for (const a of linked.filter((a) => a.connectionId === c.id)) {
        const key = a.institutionId ?? "unknown";
        const entry =
          byInstitution.get(key) ??
          ({ institutionId: key, institution: a.institution, lastUpdated: null, stale: false, messages: [], accounts: [] } as InstitutionHealth);
        entry.accounts.push({ id: a.id, name: a.displayName ?? a.name, balanceCents: a.balanceCents, balanceAt: a.balanceAt });
        if (a.balanceAt && (!entry.lastUpdated || a.balanceAt > entry.lastUpdated)) entry.lastUpdated = a.balanceAt;
        byInstitution.set(key, entry);
      }
      for (const entry of byInstitution.values()) {
        entry.messages = messages.filter((m) => m.institutionId === entry.institutionId);
        entry.stale = !entry.lastUpdated || now.getTime() - entry.lastUpdated.getTime() > STALE_AFTER_HOURS * 3_600_000;
      }

      return {
        id: c.id,
        label: c.label,
        status: c.status,
        lastSuccessAt: c.lastSuccessAt,
        lastError: c.lastError,
        lastRun: lastRun ? { status: lastRun.status, startedAt: lastRun.startedAt, error: lastRun.error } : null,
        messages: messages.filter((m) => !m.institutionId),
        institutions: [...byInstitution.values()],
      };
    }),
  );
}

/** One-line problems worth a banner, or an empty list when everything is current. */
export function healthProblems(health: ConnectionHealth[]): string[] {
  const problems: string[] = [];
  for (const c of health) {
    if (c.status === "broken") problems.push(`${c.label}: connection broken — ${c.lastError ?? "reconnect it"}`);
    else if (c.lastRun?.status === "failed") problems.push(`${c.label}: last sync failed — ${c.lastRun.error ?? "unknown error"}`);
    for (const i of c.institutions) {
      if (i.messages.length) problems.push(`${i.institution}: ${i.messages[0].message}`);
      else if (i.stale) problems.push(`${i.institution}: no new data in over ${STALE_AFTER_HOURS / 24} days`);
    }
  }
  return problems;
}
