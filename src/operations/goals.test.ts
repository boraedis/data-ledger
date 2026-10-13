import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, goals, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { loadGoalProgress } from "@/lib/goals/progress";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// On the synthetic seed: a savings account with daily balance history, and
// monthly "ONLINE TRANSFER TO SAVINGS" from checking to tag.

let db: Db;
const id: Record<string, string> = {};
const ON = "2026-06-30";

const run = (operation: string, input: Record<string, unknown>, actor: "user" | "tally" = "user") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<{ status: string; commandId: string; output: unknown }>;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date(ON) });
  for (const a of await db.select().from(accounts)) id[a.type] = a.id;
});

describe("savings goals", () => {
  it("tracks a goal from a linked account's balance, with history from snapshots", async () => {
    const [savings] = await db.select().from(accounts).where(eq(accounts.id, id.savings));
    await run("goals.create", { name: "Emergency fund", targetCents: 2_000_000, targetDate: "2026-12-31", accountIds: [id.savings], tagName: null, startOn: "2026-03-01" });
    const [p] = await loadGoalProgress(db, { today: ON });
    expect(p.currentCents).toBe(savings.balanceCents);
    expect(p.series[0].on).toBe("2026-03-01");
    expect(p.startCents).toBeLessThan(p.currentCents); // the seed's savings grow every month
    expect(["on_track", "behind"]).toContain(p.status.kind);
    expect(p.monthlyNeededCents).toBe(Math.ceil((2_000_000 - p.currentCents) / 7));
  });

  it("tracks a goal from tagged transfers, creating the tag", async () => {
    await run("goals.create", { name: "Trip", targetCents: 150_000, targetDate: null, accountIds: [], tagName: "trip-fund" });
    const transfers = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, id.checking), like(transactions.description, "ONLINE TRANSFER TO SAVINGS%")));
    for (const t of transfers.slice(0, 3)) await run("transactions.setTags", { transactionId: t.id, tags: ["trip-fund"] });
    const [p] = await loadGoalProgress(db, { today: ON });
    expect(p.currentCents).toBe(transfers.slice(0, 3).reduce((s, t) => s - t.amountCents, 0));
    expect(p.tagName).toBe("trip-fund");

    // The tag can't be deleted out from under the goal.
    const tag = ((await run("tags.list", {})).output as { id: string; name: string }[]).find((t) => t.name === "trip-fund")!;
    await expect(run("tags.delete", { tagId: tag.id })).rejects.toThrow(/Trip/);
  });

  it("validates sources and dates, updates links, archives and restores", async () => {
    await expect(run("goals.create", { name: "X", targetCents: 1, targetDate: null, accountIds: [], tagName: null })).rejects.toThrow(/Link an account or a tag/);
    await expect(run("goals.create", { name: "X", targetCents: 1, targetDate: null, accountIds: [id.credit], tagName: null })).rejects.toThrow(/not cards or loans/);
    await expect(run("goals.create", { name: "X", targetCents: 1, targetDate: "2020-01-01", accountIds: [id.savings], tagName: null })).rejects.toThrow(/future/);

    const created = await run("goals.create", { name: "House", targetCents: 5_000_000, targetDate: null, accountIds: [id.savings, id.brokerage], tagName: null });
    const goalId = (created.output as { id: string }).id;
    await run("goals.update", { goalId, name: "House deposit", targetCents: 6_000_000, targetDate: null, accountIds: [id.savings], tagName: null });
    let [listed] = (await run("goals.list", {})).output as { name: string; accountIds: string[] }[];
    expect(listed).toMatchObject({ name: "House deposit", accountIds: [id.savings] });

    await run("goals.archive", { goalId, archived: true });
    expect(await loadGoalProgress(db, { today: ON })).toHaveLength(0);
    expect(await loadGoalProgress(db, { today: ON, archived: true })).toHaveLength(1);

    await run("goals.archive", { goalId, archived: false });
    [listed] = (await run("goals.list", {})).output as { name: string; accountIds: string[] }[];
    expect(listed.name).toBe("House deposit");
  });

  it("lets Tally see goal definitions but not balances, and propose new goals", async () => {
    await run("goals.create", { name: "Emergency fund", targetCents: 2_000_000, targetDate: null, accountIds: [id.savings], tagName: null });
    const listed = ((await run("goals.list", {}, "tally")).output as Record<string, unknown>[])[0];
    expect(Object.keys(listed).sort()).toEqual(["accountIds", "archived", "id", "name", "startOn", "tagName", "targetCents", "targetDate"]);
    expect((await run("goals.create", { name: "Car", targetCents: 1_000_000, targetDate: null, accountIds: [id.savings], tagName: null }, "tally")).status).toBe("proposed");
    expect(await db.select().from(goals)).toHaveLength(1);
  });
});
