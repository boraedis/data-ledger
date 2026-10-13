import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { accounts, balanceSnapshots, goalAccounts, goals, tags, transactionTags, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { elapsedShare, evenPace, monthlyNeeded } from "@/lib/pace";

// Savings-goal progress (#10). Progress is
//   the linked accounts' balances (today: their current balance; earlier
//   days: the daily balance snapshots, carried forward, #25)
// + money moved toward the goal in tagged transfers: a transfer out of
//   checking tagged #vacation counts +$300 (contribution = −amount), and
//   money taken back counts against it. A tagged transaction in a linked
//   account is skipped — its effect is already in that balance.
//
// Not an operation: it includes account balances, and balances never go to
// a model (AGENTS.md). Pages call it directly.

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * DAY_MS).toISOString().slice(0, 10);

export type GoalInput = {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string | null;
  startOn: string;
  tagName: string | null;
  linked: { id: string; name: string; currentCents: number; snapshots: { on: string; cents: number }[] }[];
  tagged: { date: string; amountCents: number; accountId: string }[];
};

export type GoalStatus =
  | { kind: "reached" }
  | { kind: "on_track"; expectedCents: number }
  | { kind: "behind"; expectedCents: number; shortCents: number }
  | { kind: "overdue" }
  | { kind: "no_date"; projectedOn: string | null };

export type GoalProgress = {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string | null;
  startOn: string;
  tagName: string | null;
  accounts: { id: string; name: string }[];
  currentCents: number;
  startCents: number;
  share: number; // of the target, 0–1+
  status: GoalStatus;
  // To reach the target by its date from here, per month.
  monthlyNeededCents: number | null;
  series: { on: string; cents: number }[];
};

/** Progress on each day from `from` through today. */
function seriesFor(goal: GoalInput, today: string, from: string): { on: string; cents: number }[] {
  const linkedIds = new Set(goal.linked.map((a) => a.id));
  const contributions = goal.tagged
    .filter((t) => !linkedIds.has(t.accountId))
    .map((t) => ({ date: t.date, cents: -t.amountCents }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const snapshots = goal.linked.map((a) => [...a.snapshots].sort((x, y) => x.on.localeCompare(y.on)));

  const series: { on: string; cents: number }[] = [];
  const latest = goal.linked.map(() => 0);
  const cursor = goal.linked.map(() => 0);
  let tagged = 0;
  let ci = 0;
  // Everything before the start counts toward where the line begins.
  for (let day = from; day <= today; day = addDays(day, 1)) {
    snapshots.forEach((list, a) => {
      while (cursor[a] < list.length && list[cursor[a]].on <= day) latest[a] = list[cursor[a]++].cents;
    });
    while (ci < contributions.length && contributions[ci].date <= day) tagged += contributions[ci++].cents;
    // Today uses current balances, the same figure net worth shows.
    const balances = day === today ? goal.linked.reduce((s, a) => s + a.currentCents, 0) : latest.reduce((s, c) => s + c, 0);
    series.push({ on: day, cents: balances + tagged });
  }
  return series;
}

export function goalProgress(goal: GoalInput, today: string): GoalProgress {
  const end = today < goal.startOn ? goal.startOn : today;
  // The trend looks at the 90 days before today even for a goal set
  // yesterday — money saved before the goal existed still shows the pace.
  const trendFrom = addDays(end, -90);
  const full = seriesFor(goal, end, trendFrom < goal.startOn ? trendFrom : goal.startOn);
  const series = full.filter((d) => d.on >= goal.startOn);
  const startCents = series[0]?.cents ?? 0;
  const currentCents = series.at(-1)?.cents ?? 0;
  const remaining = goal.targetCents - currentCents;

  let status: GoalStatus;
  if (remaining <= 0) status = { kind: "reached" };
  else if (!goal.targetDate) {
    // No date: project from the last 90 days' trend, if it's heading up.
    const back = full[Math.max(0, full.length - 91)];
    const days = full.length - 1 - Math.max(0, full.length - 91);
    const perDay = days > 0 ? (currentCents - back.cents) / days : 0;
    status = { kind: "no_date", projectedOn: perDay > 0 ? addDays(today, Math.ceil(remaining / perDay)) : null };
  } else if (today > goal.targetDate) status = { kind: "overdue" };
  else {
    // An even pace from where you were at the start to the target by the date.
    const expectedCents = evenPace(startCents, goal.targetCents, elapsedShare(goal.startOn, goal.targetDate, today));
    // A 1% cushion, so a few dollars short isn't "behind".
    status =
      currentCents >= expectedCents - goal.targetCents * 0.01
        ? { kind: "on_track", expectedCents }
        : { kind: "behind", expectedCents, shortCents: expectedCents - currentCents };
  }

  return {
    id: goal.id,
    name: goal.name,
    targetCents: goal.targetCents,
    targetDate: goal.targetDate,
    startOn: goal.startOn,
    tagName: goal.tagName,
    accounts: goal.linked.map(({ id, name }) => ({ id, name })),
    currentCents,
    startCents,
    share: goal.targetCents > 0 ? currentCents / goal.targetCents : 0,
    status,
    monthlyNeededCents: goal.targetDate && remaining > 0 ? monthlyNeeded(remaining, today, goal.targetDate) : null,
    series,
  };
}

/** Every active goal with its progress; `archived: true` includes archived ones too. */
export async function loadGoalProgress(db: Db, { today = new Date().toISOString().slice(0, 10), archived = false } = {}): Promise<GoalProgress[]> {
  const rows = await db
    .select({ goal: goals, tagName: tags.name })
    .from(goals)
    .leftJoin(tags, eq(tags.id, goals.tagId))
    .where(archived ? undefined : isNull(goals.archivedAt))
    .orderBy(asc(goals.createdAt));
  if (rows.length === 0) return [];
  const goalIds = rows.map((r) => r.goal.id);
  const links = await db
    .select({ goalId: goalAccounts.goalId, accountId: accounts.id, name: accounts.name, displayName: accounts.displayName, balanceCents: accounts.balanceCents })
    .from(goalAccounts)
    .innerJoin(accounts, eq(accounts.id, goalAccounts.accountId))
    .where(inArray(goalAccounts.goalId, goalIds));
  const accountIds = [...new Set(links.map((l) => l.accountId))];
  const tagIds = rows.map((r) => r.goal.tagId).filter((id): id is string => Boolean(id));
  const [snapshots, tagged] = await Promise.all([
    accountIds.length
      ? db
          .select({ accountId: balanceSnapshots.accountId, on: balanceSnapshots.on, cents: balanceSnapshots.balanceCents })
          .from(balanceSnapshots)
          .where(inArray(balanceSnapshots.accountId, accountIds))
      : Promise.resolve([]),
    tagIds.length
      ? db
          .select({ tagId: transactionTags.tagId, date: transactions.postedOn, amountCents: transactions.amountCents, accountId: transactions.accountId })
          .from(transactionTags)
          .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
          .where(and(inArray(transactionTags.tagId, tagIds), eq(transactions.pending, false)))
      : Promise.resolve([]),
  ]);

  return rows.map(({ goal, tagName }) =>
    goalProgress(
      {
        id: goal.id,
        name: goal.name,
        targetCents: goal.targetCents,
        targetDate: goal.targetDate,
        startOn: goal.startOn,
        tagName,
        linked: links
          .filter((l) => l.goalId === goal.id)
          .map((l) => ({
            id: l.accountId,
            name: l.displayName ?? l.name,
            currentCents: l.balanceCents ?? 0,
            snapshots: snapshots.filter((s) => s.accountId === l.accountId),
          })),
        tagged: goal.tagId ? tagged.filter((t) => t.tagId === goal.tagId) : [],
      },
      today,
    ),
  );
}
