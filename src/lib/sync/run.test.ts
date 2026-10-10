import { randomBytes } from "crypto";
import { count, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  balanceSnapshots,
  categories,
  commandLog,
  connections,
  syncRuns,
  transactionSplits,
  transactionTags,
  transactions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { encryptSecret } from "@/lib/crypto";
import { ConnectorAuthError, type ConnectorSnapshot } from "@/lib/connectors/types";
import { getConnectionHealth, healthProblems } from "@/lib/sync/health";
import { MAX_REQUESTS_PER_DAY, syncConnection, syncWindowStart } from "@/lib/sync/run";
import { testDb } from "@/lib/test-utils/db";
import { execute, undoCommand } from "@/operations/runtime";

// End to end on PGlite with a fake connector: the sync runner, the import
// operation, the command log, and health. All data invented.

let db: Db;
let connectionId: string;
let snapshot: ConnectorSnapshot;
let fetchError: Error | null;
let fetchedSince: Date[];
let requestsPerFetch: number;

const fakeConnector = () => ({
  requestsFor: () => requestsPerFetch,
  fetch: async (since: Date) => {
    fetchedSince.push(since);
    if (fetchError) throw fetchError;
    return structuredClone(snapshot);
  },
});

const account = (overrides = {}) => ({
  externalId: "ACT-1",
  name: "Everyday Checking",
  institution: "Example Credit Union",
  institutionId: "CON-1",
  currency: "USD",
  balanceCents: 100_000,
  availableBalanceCents: null,
  balanceAt: new Date("2026-06-29T12:00:00Z"),
  ...overrides,
});

const txn = (id: string, overrides = {}) => ({
  accountExternalId: "ACT-1",
  externalId: id,
  postedOn: "2026-06-28",
  amountCents: -4250,
  description: "CORNER BEAN CAFE",
  payee: null,
  memo: null,
  pending: false,
  ...overrides,
});

const now = new Date("2026-06-30T10:17:00Z");
const sync = (at = now) => syncConnection(db, connectionId, { trigger: "cron", now: at, connectorFor: fakeConnector });

async function rows() {
  return db.select().from(transactions).orderBy(transactions.externalId);
}

beforeEach(async () => {
  process.env.CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  db = await testDb();
  [{ id: connectionId }] = await db
    .insert(connections)
    .values({ provider: "fake", label: "Test bridge", encryptedSecret: encryptSecret("unused") })
    .returning({ id: connections.id });
  snapshot = {
    accounts: [account()],
    transactions: [txn("T1"), txn("T2", { amountCents: -1999 })],
    messages: [],
    requests: 1,
  };
  requestsPerFetch = 1;
  fetchError = null;
  fetchedSince = [];
});

describe("sync window", () => {
  it("backfills 90 days the first time, then overlaps the last success by 5 days", () => {
    expect(syncWindowStart(null, now).getTime()).toBe(now.getTime() - 90 * 86_400_000);
    const last = new Date("2026-06-29T10:17:00Z");
    expect(syncWindowStart(last, now).getTime()).toBe(last.getTime() - 5 * 86_400_000);
    expect(syncWindowStart(new Date("2020-01-01"), now).getTime()).toBe(now.getTime() - 90 * 86_400_000);
  });

  it("uses the last success for the next sync", async () => {
    await sync();
    await sync(new Date(now.getTime() + 86_400_000));
    expect(fetchedSince[1].getTime()).toBe(now.getTime() - 5 * 86_400_000);
  });
});

describe("syncConnection", () => {
  it("imports accounts and transactions as one logged import command", async () => {
    const result = await sync();
    expect(result).toMatchObject({ status: "success", inserted: 2, updated: 0, removed: 0 });

    const [acct] = await db.select().from(accounts);
    expect(acct).toMatchObject({ source: "simplefin", connectionId, type: "checking", balanceCents: 100_000 });
    expect(await rows()).toHaveLength(2);

    const log = await db.select().from(commandLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "import", operation: "import.applySnapshot", reason: "Nightly bank sync" });
    const [run] = await db.select().from(syncRuns);
    expect(run).toMatchObject({ status: "success", requests: 1, commandId: log[0].id, inserted: 2 });
  });

  it("is idempotent: the same snapshot again changes nothing", async () => {
    await sync();
    const second = await sync();
    expect(second).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
    expect(await rows()).toHaveLength(2);
    const log = await db.select().from(commandLog);
    expect(log[1].changes).toEqual([]);
  });

  it("updates changed bank fields but never the owner's category", async () => {
    await sync();
    const [cat] = await db.insert(categories).values({ name: "Coffee", kind: "expense" }).returning();
    const [t1] = await db.select().from(transactions).where(eq(transactions.externalId, "T1"));
    await execute(db, { operation: "transactions.setCategory", input: { transactionId: t1.id, categoryId: cat.id }, actor: "user", reason: "x" });

    snapshot.transactions[0].description = "CORNER BEAN CAFE #12";
    expect(await sync()).toMatchObject({ updated: 1 });
    const [after] = await db.select().from(transactions).where(eq(transactions.externalId, "T1"));
    expect(after).toMatchObject({ description: "CORNER BEAN CAFE #12", categoryId: cat.id });
  });

  it("replaces a vanished pending transaction with its posted version, carrying the category", async () => {
    snapshot.transactions = [txn("P1", { pending: true, postedOn: "2026-06-27", amountCents: -999 })];
    await sync();
    const [cat] = await db.insert(categories).values({ name: "Subscriptions", kind: "expense" }).returning();
    const [pending] = await rows();
    await execute(db, { operation: "transactions.setCategory", input: { transactionId: pending.id, categoryId: cat.id }, actor: "user", reason: "x" });

    // Posted under a new ID two days later; the pending one is gone.
    snapshot.transactions = [txn("X9", { postedOn: "2026-06-29", amountCents: -999 })];
    expect(await sync()).toMatchObject({ inserted: 1, removed: 1 });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ externalId: "X9", pending: false, categoryId: cat.id });
  });

  it("carries a pending row's split, tags and experience date to its posted version, undoably", async () => {
    snapshot.transactions = [txn("P1", { pending: true, postedOn: "2026-06-27", amountCents: -1000 })];
    await sync();
    const [food] = await db.insert(categories).values({ name: "Food", kind: "expense" }).returning();
    const [fun] = await db.insert(categories).values({ name: "Fun", kind: "expense" }).returning();
    const [pending] = await rows();
    const as = (operation: string, input: Record<string, unknown>) =>
      execute(db, { operation, input: { transactionId: pending.id, ...input }, actor: "user", reason: "x" });
    await as("transactions.split", {
      parts: [
        { amountCents: -600, categoryId: food.id },
        { amountCents: -400, categoryId: fun.id, note: "arcade" },
      ],
    });
    await as("transactions.setTags", { tags: ["trip"] });
    await as("transactions.setExperienceDate", { experiencedOn: "2026-07-04" });

    snapshot.transactions = [txn("X9", { postedOn: "2026-06-29", amountCents: -1000 })];
    await sync(new Date(now.getTime() + 86_400_000));
    const [posted] = await rows();
    expect(posted).toMatchObject({ externalId: "X9", isSplit: true, experiencedOn: "2026-07-04" });
    const parts = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, posted.id));
    expect(parts.map((p) => [p.amountCents, p.note])).toEqual([[-600, null], [-400, "arcade"]]);
    expect(await db.select().from(transactionTags).where(eq(transactionTags.transactionId, posted.id))).toHaveLength(1);

    // Undoing that sync brings the pending row back with everything on it.
    const [syncEntry] = await db.select().from(commandLog).where(eq(commandLog.operation, "import.applySnapshot")).orderBy(desc(commandLog.createdAt)).limit(1);
    await undoCommand(db, syncEntry.id);
    const restored = await rows();
    expect(restored.map((r) => r.externalId)).toEqual(["P1"]);
    expect(await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, pending.id))).toHaveLength(2);
    expect(await db.select().from(transactionTags).where(eq(transactionTags.transactionId, pending.id))).toHaveLength(1);
  });

  it("only judges pending transactions inside the fetched window", async () => {
    // Two pending rows: one dated inside the next sync's window, one before it.
    snapshot.transactions = [
      txn("INSIDE", { pending: true, postedOn: "2026-06-27" }),
      txn("BEFORE", { pending: true, postedOn: "2026-06-20" }),
    ];
    await sync();
    // Next sync a day later: window starts 5 days before the last success
    // (Jun 25), and the provider returns neither row.
    snapshot.transactions = [];
    expect(await sync(new Date(now.getTime() + 86_400_000))).toMatchObject({ removed: 1 });
    // The Jun 20 row wasn't asked for, so its absence proves nothing.
    expect((await rows()).map((r) => r.externalId)).toEqual(["BEFORE"]);
  });

  it("derives merchants on import and categorizes right after the sync", async () => {
    const [coffee] = await db.insert(categories).values({ name: "Coffee", kind: "expense" }).returning();
    await execute(db, {
      operation: "rules.create",
      input: { matchField: "merchant", matchType: "equals", pattern: "Corner Bean Cafe", categoryId: coffee.id },
      actor: "user",
      reason: "x",
    });
    const result = await sync();
    expect(result).toMatchObject({ status: "success", categorized: 2 });
    expect((await rows()).every((t) => t.merchant === "Corner Bean Cafe" && t.categoryId === coffee.id)).toBe(true);
  });

  it("can be undone as a whole", async () => {
    await sync();
    const [entry] = await db.select().from(commandLog);
    await undoCommand(db, entry.id);
    expect(await rows()).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(balanceSnapshots)).toHaveLength(0);
  });

  it("records one balance snapshot per account per day, replaced by a later sync that day", async () => {
    await sync();
    snapshot.accounts = [account({ balanceCents: 95_000, balanceAt: new Date("2026-06-30T15:00:00Z") })];
    await sync(new Date(now.getTime() + 3_600_000));
    let snaps = await db.select().from(balanceSnapshots);
    expect(snaps.map((s) => [s.on, s.balanceCents])).toEqual([["2026-06-30", 95_000]]);

    // Next day, unchanged balance: still a data point.
    await sync(new Date(now.getTime() + 86_400_000));
    snaps = await db.select().from(balanceSnapshots).orderBy(balanceSnapshots.on);
    expect(snaps.map((s) => [s.on, s.balanceCents])).toEqual([
      ["2026-06-30", 95_000],
      ["2026-07-01", 95_000],
    ]);
  });

  it("undoing a sync restores the day's earlier snapshot", async () => {
    await sync();
    snapshot.accounts = [account({ balanceCents: 95_000 })];
    await sync(new Date(now.getTime() + 3_600_000));
    const [latest] = await db.select().from(commandLog).orderBy(desc(commandLog.createdAt)).limit(1);
    await undoCommand(db, latest.id);
    const snaps = await db.select().from(balanceSnapshots);
    expect(snaps.map((s) => s.balanceCents)).toEqual([100_000]);
  });

  it("refuses the import operation to anyone but the import actor", async () => {
    await expect(
      execute(db, {
        operation: "import.applySnapshot",
        input: { connectionId, windowStart: "2026-06-01", accounts: [], transactions: [] },
        actor: "user",
        reason: "hand-made bank data",
      }),
    ).rejects.toThrow(/may not run/);
  });

  it("marks the connection broken on a rejected credential, and recovers on the next success", async () => {
    fetchError = new ConnectorAuthError("SimpleFIN rejected the access credentials (403).");
    expect(await sync()).toMatchObject({ status: "failed" });
    let [conn] = await db.select().from(connections);
    expect(conn).toMatchObject({ status: "broken", lastSuccessAt: null });
    expect(healthProblems(await getConnectionHealth(db, now))[0]).toMatch(/broken/);

    fetchError = null;
    await sync();
    [conn] = await db.select().from(connections);
    expect(conn).toMatchObject({ status: "active", lastError: null });
  });

  it("doesn't break the connection on an ordinary failure", async () => {
    fetchError = new Error("SimpleFIN returned 500");
    await sync();
    const [conn] = await db.select().from(connections);
    expect(conn).toMatchObject({ status: "active", lastError: "SimpleFIN returned 500" });
  });

  it("stops at the daily request budget without calling the provider", async () => {
    for (let i = 0; i < MAX_REQUESTS_PER_DAY; i++) await sync(new Date(now.getTime() + i * 60_000));
    const callsBefore = fetchedSince.length;
    expect(await sync(new Date(now.getTime() + 3_600_000))).toMatchObject({ status: "skipped" });
    expect(fetchedSince).toHaveLength(callsBefore);
    // A day later the budget is back.
    expect(await sync(new Date(now.getTime() + 25 * 3_600_000))).toMatchObject({ status: "success" });
  });

  it("budgets by requests, so a multi-request backfill can't overshoot", async () => {
    for (let i = 0; i < MAX_REQUESTS_PER_DAY - 1; i++) await sync(new Date(now.getTime() + i * 60_000));
    // One request left; a fetch needing two must not start.
    requestsPerFetch = 2;
    snapshot.requests = 2;
    const callsBefore = fetchedSince.length;
    expect(await sync(new Date(now.getTime() + 3_600_000))).toMatchObject({ status: "skipped" });
    expect(fetchedSince).toHaveLength(callsBefore);
  });

  it("records provider messages as a partial sync and surfaces them per institution", async () => {
    snapshot.messages = [{ code: "con.auth", message: "Example Credit Union needs you to sign in again", institutionId: "CON-1" }];
    expect(await sync()).toMatchObject({ status: "partial", inserted: 2 });
    const [health] = await getConnectionHealth(db, now);
    expect(health.institutions[0]).toMatchObject({ institution: "Example Credit Union", stale: false });
    expect(health.institutions[0].messages).toHaveLength(1);
    expect(healthProblems([health])).toEqual(["Example Credit Union: Example Credit Union needs you to sign in again"]);
  });

  it("flags an institution whose data has stopped updating", async () => {
    await sync();
    const [health] = await getConnectionHealth(db, new Date(now.getTime() + 4 * 86_400_000));
    expect(health.institutions[0].stale).toBe(true);
  });

  it("excludes a new investment account from budgets before the owner has seen it", async () => {
    snapshot.accounts = [account(), account({ externalId: "ACT-9", name: "Roth IRA" })];
    await sync();
    const [ira] = await db.select().from(accounts).where(eq(accounts.externalId, "ACT-9"));
    expect(ira).toMatchObject({ type: "retirement", countsTowardBudgets: false });
  });

  it("never overwrites the owner's display name, kind or budget flag", async () => {
    await sync();
    const [acct] = await db.select().from(accounts);
    await execute(db, {
      operation: "accounts.update",
      input: { accountId: acct.id, kind: "savings", displayName: "Emergency fund", countsTowardBudgets: false },
      actor: "user",
      reason: "x",
    });
    snapshot.accounts = [account({ name: "EVERYDAY CHECKING (renamed by bank)", balanceCents: 123 })];
    await sync();
    const [after] = await db.select().from(accounts);
    expect(after).toMatchObject({
      name: "EVERYDAY CHECKING (renamed by bank)",
      balanceCents: 123,
      displayName: "Emergency fund",
      type: "savings",
      countsTowardBudgets: false,
    });
  });

  it("guesses account types once and never overrides them afterwards", async () => {
    snapshot.accounts = [account(), account({ externalId: "ACT-2", name: "Rewards Visa Card" })];
    await sync();
    const types = Object.fromEntries((await db.select().from(accounts)).map((a) => [a.name, a.type]));
    expect(types).toEqual({ "Everyday Checking": "checking", "Rewards Visa Card": "credit" });

    await db.update(accounts).set({ type: "savings" }).where(eq(accounts.externalId, "ACT-1"));
    await sync();
    const [acct] = await db.select().from(accounts).where(eq(accounts.externalId, "ACT-1"));
    expect(acct.type).toBe("savings");
    const [{ value }] = await db.select({ value: count() }).from(accounts);
    expect(value).toBe(2);
  });
});
