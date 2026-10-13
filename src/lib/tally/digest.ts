import { desc, gte, sum } from "drizzle-orm";
import { digests, syncRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { chat as defaultChat } from "@/lib/model/client";
import { formatCents } from "@/lib/money";
import { getConnectionHealth, healthProblems } from "@/lib/sync/health";
import { budgetStatus } from "@/operations/budgets";
import { listAlerts } from "@/operations/recurring";
import { owedToMe } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { inboxCount } from "@/operations/transactions";

// The nightly digest, written by Tally (#11) from the day's facts: how the
// sync went, what's waiting in the inbox, open alerts, budget pace and
// what's owed. Written at the end of the nightly classify chain, when the
// model is already awake.
//
// The facts are gathered here, not by the model calling tools: the digest
// should say the same things every night, in the same order, from exactly
// these numbers — and they're stored beside it, so any sentence can be
// checked against what the model was told. Minimal data as always: no
// balances (connection health carries them; only its status text is used).

export type DigestFacts = {
  date: string;
  sync: { connections: { label: string; ok: boolean; lastSuccess: string | null }[]; problems: string[]; newTransactions: number };
  inbox: number;
  alerts: { title: string; detail: string; on: string }[];
  budgets: { name: string; period: string; spent: string; available: string; left: string; over: boolean; periodElapsed: string }[];
  owedToYou: string | null;
};

export async function gatherFacts(db: Db, today: string): Promise<DigestFacts> {
  const since = new Date(Date.parse(today) - 86_400_000);
  const [health, inbox, alerts, budgets, owed, [{ value: inserted }]] = await Promise.all([
    getConnectionHealth(db),
    inboxCount(db),
    read(db, listAlerts, { limit: 10 }),
    read(db, budgetStatus, { on: today }),
    read(db, owedToMe, { on: today }),
    db.select({ value: sum(syncRuns.inserted) }).from(syncRuns).where(gte(syncRuns.startedAt, since)),
  ]);
  return {
    date: today,
    sync: {
      connections: health.map((c) => ({ label: c.label, ok: c.status === "active", lastSuccess: c.lastSuccessAt?.toISOString().slice(0, 10) ?? null })),
      problems: healthProblems(health),
      newTransactions: Number(inserted ?? 0),
    },
    inbox,
    alerts: alerts.map((a) => ({ title: a.title, detail: a.detail, on: a.occurredOn })),
    budgets: budgets.targets.map((t) => ({
      name: t.name,
      period: `${t.start} to ${t.end}`,
      spent: formatCents(t.spentCents),
      available: formatCents(t.availableCents),
      left: formatCents(t.remainingCents),
      over: t.remainingCents < 0,
      periodElapsed: `${Math.round(t.elapsedShare * 100)}%`,
    })),
    owedToYou: owed.totalCents ? formatCents(owed.totalCents) : null,
  };
}

const INSTRUCTIONS = [
  "You are Tally, writing the owner's short daily note for their personal finance app.",
  "Use only the facts given, in JSON. Never add numbers, merchants or advice that aren't there.",
  "Order: anything broken or needing action first (sync problems, alerts, budgets over), then the rest briefly.",
  "For budgets, compare spent to how far through the period it is (periodElapsed); mention only the notable ones.",
  "3 to 6 short lines, plain text, '- ' bullets allowed. No greeting, no sign-off. If nothing needs attention, say so in one line.",
].join("\n");

/** Writes (or rewrites) today's digest. Returns it, or null when the model couldn't be reached in time. */
export async function writeDigest(
  db: Db,
  { today = new Date().toISOString().slice(0, 10), deadline, chat = defaultChat }: { today?: string; deadline?: number; chat?: typeof defaultChat } = {},
): Promise<string | null> {
  const facts = await gatherFacts(db, today);
  try {
    const reply = await chat(
      {
        feature: "digest",
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: JSON.stringify(facts) },
        ],
        mode: "background",
        deadline,
        maxTokens: 400,
        temperature: 0.2,
      },
      { db },
    );
    const content = (reply.content ?? "").trim();
    if (!content) return null;
    // One per day: a second run (a manual retrigger) replaces the first.
    await db
      .insert(digests)
      .values({ on: today, content, facts })
      .onConflictDoUpdate({ target: digests.on, set: { content, facts, createdAt: new Date() } });
    return content;
  } catch (error) {
    console.error("Digest not written:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

export async function latestDigest(db: Db) {
  const [row] = await db.select().from(digests).orderBy(desc(digests.on)).limit(1);
  return row ?? null;
}

