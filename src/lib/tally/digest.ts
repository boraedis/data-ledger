import { desc, eq, gte, inArray, lt, lte, max, sum } from "drizzle-orm";
import { accounts, digests, holdingSnapshots, syncRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { chat as defaultChat } from "@/lib/model/client";
import { formatCents } from "@/lib/money";
import { getConnectionHealth, healthProblems } from "@/lib/sync/health";
import { investmentMoves, investmentsText, type HoldingRow, type InvestmentMoves } from "@/lib/tally/movers";
import { budgetStatus } from "@/operations/budgets";
import { listAlerts } from "@/operations/recurring";
import { owedToMe } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { listFlags } from "@/operations/suspicious";
import { inboxCount } from "@/operations/transactions";

// The nightly digest, written by Tally (#11) from the day's facts: how the
// sync went, what's waiting in the inbox, open alerts, budget pace and
// what's over and by how much, and what's owed. Written at the end of the
// nightly classify chain, when the model is already awake. It's the summary
// at the top of the Inbox (#214), with a line of it on Home; only the
// newest shows, and only the nightly run writes it.
//
// Investments are added after the model's note as fixed text built from the
// numbers (src/lib/tally/movers.ts), so holdings never reach the model.
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
  // Charges flagged as possibly not the owner's (#33), waiting for a verdict.
  flaggedCharges: number;
  alerts: { title: string; detail: string; on: string }[];
  budgets: { name: string; period: string; spent: string; available: string; left: string; over: boolean; overBy: string | null; periodElapsed: string }[];
  owedToYou: string | null;
};

export async function gatherFacts(db: Db, today: string): Promise<DigestFacts> {
  const since = new Date(Date.parse(today) - 86_400_000);
  const [health, inbox, flags, alerts, budgets, owed, [{ value: inserted }]] = await Promise.all([
    getConnectionHealth(db),
    inboxCount(db),
    read(db, listFlags, {}),
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
    flaggedCharges: flags.open.length,
    alerts: alerts.map((a) => ({ title: a.title, detail: a.detail, on: a.occurredOn })),
    budgets: budgets.targets.map((t) => ({
      name: t.name,
      period: `${t.start} to ${t.end}`,
      spent: formatCents(t.spentCents),
      available: formatCents(t.availableCents),
      left: formatCents(t.remainingCents),
      over: t.remainingCents < 0,
      overBy: t.remainingCents < 0 ? formatCents(-t.remainingCents) : null,
      periodElapsed: `${Math.round(t.elapsedShare * 100)}%`,
    })),
    owedToYou: owed.totalCents ? formatCents(owed.totalCents) : null,
  };
}

const INSTRUCTIONS = [
  "You are Tally, writing the owner's short daily note for their personal finance app.",
  "Use only the facts given, in JSON. Never add numbers, merchants or advice that aren't there.",
  "Order: anything broken or needing action first (sync problems, alerts, budgets over), then the rest briefly.",
  "Always name every budget that's over, with how much it's over by (overBy). For the rest, compare spent to how far " +
    "through the period it is (periodElapsed); mention only the notable ones.",
  "Inbox: one line with the count; name flaggedCharges only when there are some.",
  "3 to 6 short lines, plain text, '- ' bullets allowed. No greeting, no sign-off. If nothing needs attention, say so in one line.",
].join("\n");

/** How holdings moved between the two newest snapshot days up to `today`, or null with fewer than two. */
export async function gatherInvestmentMoves(db: Db, today: string): Promise<InvestmentMoves | null> {
  const [{ latest }] = await db.select({ latest: max(holdingSnapshots.on) }).from(holdingSnapshots).where(lte(holdingSnapshots.on, today));
  if (!latest) return null;
  const [{ previous }] = await db.select({ previous: max(holdingSnapshots.on) }).from(holdingSnapshots).where(lt(holdingSnapshots.on, latest));
  if (!previous) return null;
  const rows = await db
    .select({
      on: holdingSnapshots.on,
      accountName: accounts.name,
      externalId: holdingSnapshots.externalId,
      symbol: holdingSnapshots.symbol,
      description: holdingSnapshots.description,
      shares: holdingSnapshots.shares,
      marketValueCents: holdingSnapshots.marketValueCents,
    })
    .from(holdingSnapshots)
    .innerJoin(accounts, eq(accounts.id, holdingSnapshots.accountId))
    .where(inArray(holdingSnapshots.on, [latest, previous]));
  const day = (on: string): { on: string; rows: HoldingRow[] } => ({ on, rows: rows.filter((r) => r.on === on) });
  return investmentMoves(day(previous), day(latest));
}

/** Writes (or rewrites) today's digest. Returns it, or null when the model couldn't be reached in time. */
export async function writeDigest(
  db: Db,
  { today = new Date().toISOString().slice(0, 10), deadline, chat = defaultChat }: { today?: string; deadline?: number; chat?: typeof defaultChat } = {},
): Promise<string | null> {
  const [facts, moves] = await Promise.all([gatherFacts(db, today), gatherInvestmentMoves(db, today)]);
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
    const note = (reply.content ?? "").trim();
    if (!note) return null;
    const content = moves ? `${note}\n${investmentsText(moves)}` : note;
    // What the model was told, plus what was added after it under `fixed`,
    // which it never saw: every sentence can still be checked.
    const stored = { ...facts, fixed: { investments: moves } };
    // One per day: a second run (a manual retrigger) replaces the first.
    await db
      .insert(digests)
      .values({ on: today, content, facts: stored })
      .onConflictDoUpdate({ target: digests.on, set: { content, facts: stored, createdAt: new Date() } });
    return content;
  } catch (error) {
    console.error("Digest not written:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/** The summary's first line, for Home's one-line version (#214): its own words, without the bullet. */
export function summaryHeadline(content: string): string {
  const first = content.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/^[-*•]\s*/, "");
}

export async function latestDigest(db: Db) {
  const [row] = await db.select().from(digests).orderBy(desc(digests.on)).limit(1);
  return row ?? null;
}

