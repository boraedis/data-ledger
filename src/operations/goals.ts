import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, goalAccounts, goals, tags } from "@/db/schema";
import { isLiability } from "@/lib/net-worth";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Savings goals (#10). These operations hold the definitions — name,
// target, date, linked accounts, tag — which Tally may read and propose
// changes to. Progress includes account balances, so it lives in
// src/lib/goals/progress.ts and never reaches a model.

const today = () => new Date().toISOString().slice(0, 10);

const fields = {
  name: z.string().trim().min(1).max(60),
  targetCents: z.number().int().min(1).max(100_000_000_00),
  targetDate: z.iso.date().nullable(),
  // Accounts whose balance counts toward it.
  accountIds: z.array(z.uuid()).max(20),
  // Transfers with this tag count toward it; created if it doesn't exist.
  tagName: z.string().trim().min(1).max(40).nullable(),
};

export const listGoals = defineRead({
  name: "goals.list",
  description:
    "Savings goals: name, target in cents, optional target date, start date, linked account ids (their balances " +
    "count toward it) and tag (transfers with it count). Progress isn't included: it uses account balances.",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  run: async (db, { includeArchived }) => {
    const rows = await db
      .select({ goal: goals, tagName: tags.name })
      .from(goals)
      .leftJoin(tags, eq(tags.id, goals.tagId))
      .orderBy(goals.createdAt);
    const links = await db.select().from(goalAccounts);
    return rows
      .filter((r) => includeArchived || !r.goal.archivedAt)
      .map(({ goal, tagName }) => ({
        id: goal.id,
        name: goal.name,
        targetCents: goal.targetCents,
        targetDate: goal.targetDate,
        startOn: goal.startOn,
        tagName,
        accountIds: links.filter((l) => l.goalId === goal.id).map((l) => l.accountId),
        archived: Boolean(goal.archivedAt),
      }));
  },
});

async function tagIdFor(ctx: WriteContext, name: string | null): Promise<string | null> {
  if (!name) return null;
  const [found] = await ctx.db.select({ id: tags.id }).from(tags).where(sql`lower(${tags.name}) = lower(${name})`);
  return found ? found.id : (await ctx.insert(tags, { name })).id;
}

async function assertAccounts(ctx: WriteContext, ids: string[]) {
  if (ids.length === 0) return;
  const found = await ctx.db.select({ id: accounts.id, kind: accounts.type }).from(accounts).where(inArray(accounts.id, ids));
  if (found.length !== new Set(ids).size) throw new NotFoundError("Account not found");
  // Saving toward something grows a balance; a card or loan balance is debt.
  if (found.some((a) => isLiability(a.kind))) throw new Error("Link savings or investment accounts, not cards or loans");
}

async function relink(ctx: WriteContext, goalId: string, accountIds: string[]) {
  const existing = await ctx.db.select().from(goalAccounts).where(eq(goalAccounts.goalId, goalId));
  for (const link of existing) if (!accountIds.includes(link.accountId)) await ctx.remove(goalAccounts, link.id);
  for (const accountId of new Set(accountIds)) {
    if (!existing.some((l) => l.accountId === accountId)) await ctx.insert(goalAccounts, { goalId, accountId });
  }
}

export const createGoal = defineWrite({
  name: "goals.create",
  description:
    "Create a savings goal: a target in cents, an optional date, and where progress comes from — linked " +
    "accounts' balances, transfers tagged tagName, or both. It needs at least one.",
  input: z.object({ ...fields, startOn: z.iso.date().optional() }),
  apply: async (ctx, input) => {
    if (input.accountIds.length === 0 && !input.tagName) throw new Error("Link an account or a tag, so progress has something to count");
    const startOn = input.startOn ?? today();
    if (input.targetDate && input.targetDate <= startOn) throw new Error("The target date should be in the future");
    await assertAccounts(ctx, input.accountIds);
    const goal = await ctx.insert(goals, {
      name: input.name,
      targetCents: input.targetCents,
      targetDate: input.targetDate,
      startOn,
      tagId: await tagIdFor(ctx, input.tagName),
    });
    await relink(ctx, goal.id, input.accountIds);
    return { id: goal.id };
  },
});

export const updateGoal = defineWrite({
  name: "goals.update",
  description: "Change a goal's name, target, date, linked accounts or tag. Its start date (where the pace line begins) stays.",
  input: z.object({ goalId: z.uuid(), ...fields }),
  apply: async (ctx, { goalId, accountIds, tagName, ...set }) => {
    const [goal] = await ctx.db.select().from(goals).where(eq(goals.id, goalId));
    if (!goal) throw new NotFoundError("Goal not found");
    if (accountIds.length === 0 && !tagName) throw new Error("Link an account or a tag, so progress has something to count");
    if (set.targetDate && set.targetDate <= goal.startOn) throw new Error("The target date should be after the goal started");
    await assertAccounts(ctx, accountIds);
    await ctx.update(goals, goalId, { ...set, tagId: await tagIdFor(ctx, tagName) });
    await relink(ctx, goalId, accountIds);
    return { id: goalId };
  },
});

export const archiveGoal = defineWrite({
  name: "goals.archive",
  description: "Archive a goal that's done or dropped (archived: true), or bring it back (false). Nothing is lost.",
  input: z.object({ goalId: z.uuid(), archived: z.boolean() }),
  apply: async (ctx, { goalId, archived }) => ctx.update(goals, goalId, { archivedAt: archived ? new Date() : null }),
});
