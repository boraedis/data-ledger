import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";

// Running every migration took about 2s, and most database tests call
// testDb() in a beforeEach, so the suite spent most of its time rebuilding
// the same schema. The migrated database is built once per test file (vitest
// gives each file its own module instance) and each call clones it, which
// takes about 0.4s. A clone is a copy, so tests still can't see each other's
// writes.
let template: Promise<PGlite> | null = null;

async function migrated(): Promise<PGlite> {
  const pg = new PGlite();
  await migrate(drizzle(pg, { schema }), { migrationsFolder: "./drizzle" });
  return pg;
}

/** A fresh in-process Postgres with every committed migration applied. */
export async function testDb(): Promise<Db> {
  template ??= migrated();
  // clone() is typed as the interface; the instance is a PGlite.
  const copy = (await (await template).clone()) as PGlite;
  return drizzle(copy, { schema }) as unknown as Db;
}

/**
 * A fresh copy of a database that already holds data, such as a seed applied
 * once in beforeAll. Seeding per test costs far more than cloning, so a file
 * that needs the same data in every test seeds once and clones here.
 */
export async function cloneDb(from: Db): Promise<Db> {
  const copy = (await (from as unknown as { $client: PGlite }).$client.clone()) as PGlite;
  return drizzle(copy, { schema }) as unknown as Db;
}
