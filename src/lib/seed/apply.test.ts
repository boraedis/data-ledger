import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { RealDataPresentError, applySeed } from "@/lib/seed/apply";

// Runs the committed migrations against an in-process Postgres, so this
// also proves drizzle/ applies cleanly to an empty database.
async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("applySeed", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("fills an empty database", async () => {
    const result = await applySeed(db, { endDate: new Date("2026-06-30") });
    const [{ value }] = await db.select({ value: count() }).from(schema.transactions);
    expect(value).toBe(result.transactions);
    expect(result.accounts).toBe(4);
  });

  it("can be re-run without duplicating anything", async () => {
    await applySeed(db, { endDate: new Date("2026-06-30") });
    const second = await applySeed(db, { endDate: new Date("2026-06-30") });
    const [{ value }] = await db.select({ value: count() }).from(schema.transactions);
    expect(value).toBe(second.transactions);
    const [{ value: accounts }] = await db.select({ value: count() }).from(schema.accounts);
    expect(accounts).toBe(4);
  });

  it("refuses, and changes nothing, when a non-seed account exists", async () => {
    await db.insert(schema.accounts).values({
      name: "Synced Checking",
      institution: "Some Bank",
      type: "checking",
      source: "simplefin",
    });
    await expect(applySeed(db)).rejects.toBeInstanceOf(RealDataPresentError);
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    const [{ value }] = await db
      .select({ value: count() })
      .from(schema.accounts)
      .where(eq(schema.accounts.source, "seed"));
    expect(value).toBe(0);
  });

  it("stores passkey public keys as bytes", async () => {
    const publicKey = new Uint8Array([1, 2, 3, 250]);
    await db.insert(schema.passkeys).values({ id: "cred", publicKey, label: "Test" });
    const [row] = await db.select().from(schema.passkeys);
    expect(Array.from(row.publicKey)).toEqual([1, 2, 3, 250]);
  });
});
