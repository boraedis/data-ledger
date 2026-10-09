import { Pool, neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";

// Node 22+ has a global WebSocket; Node 20 (local dev) doesn't.
if (typeof WebSocket === "undefined") neonConfig.webSocketConstructor = ws;

// Lazily create the client on first real use rather than at import time:
// `next build` imports every route to inspect it without DATABASE_URL set,
// and a module-scope throw breaks the build (same lesson as Data Diary).
//
// Two drivers on purpose. neon-http (getDb) is one HTTP round trip per
// query and can't hold a transaction open — ideal for page reads and auth.
// Operation writes need a write and its command-log entry to commit
// together, so they run on the WebSocket driver (withTransactionalDb).
let cachedSql: NeonQueryFunction<false, false> | undefined;

/**
 * Says what's wrong with a DATABASE_URL without ever echoing it — the
 * value carries the database password, and these messages land in logs.
 * Covers the shapes a copy from Neon's console produces: a `psql '…'`
 * command, a quoted string, stray whitespace.
 */
export function describeDatabaseUrlProblem(value: string | undefined): string | null {
  if (!value) return "DATABASE_URL is not set in this environment";
  if (value !== value.trim()) return "DATABASE_URL has leading or trailing whitespace";
  if (/^["']/.test(value)) return "DATABASE_URL is wrapped in quotes; store the bare postgresql:// URL";
  if (value.startsWith("psql")) return "DATABASE_URL is a psql command; store only the postgresql:// URL inside it";
  if (!/^postgres(ql)?:\/\//.test(value)) return "DATABASE_URL must start with postgresql://";
  return null;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  const problem = describeDatabaseUrlProblem(url);
  if (problem) throw new Error(problem);
  return url!;
}

// Local mode: a DATABASE_URL on localhost is a plain Postgres (e.g.
// `npm run db:local`, which serves PGlite over the wire protocol), so it
// uses node-postgres instead of Neon's HTTP/WebSocket drivers. Never used in
// production, where the URL is always Neon's.
export function isLocalDatabaseUrl(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

// One connection: PGlite is single-session, so two pooled connections would
// share — and corrupt — each other's transactions. The cost is that code
// inside withTransactionalDb must use the db it's given, never getDb();
// the operations layer already works that way.
let localPool: pg.Pool | undefined;
function localDb(url: string): Db {
  localPool ??= new pg.Pool({ connectionString: url, max: 1 });
  return drizzlePg(localPool, { schema }) as unknown as Db;
}

export function getDb() {
  const url = databaseUrl();
  if (isLocalDatabaseUrl(url)) return localDb(url);
  if (!cachedSql) cachedSql = neon(url);
  return drizzle(cachedSql, { schema });
}

/**
 * Runs `fn` with a database that supports transactions. The pool lives for
 * this call only: in serverless, a WebSocket pool must not outlive the
 * request that opened it (Neon's guidance), so it's opened and closed here.
 */
export async function withTransactionalDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = databaseUrl();
  if (isLocalDatabaseUrl(url)) return fn(localDb(url));
  const pool = new Pool({ connectionString: url });
  try {
    return await fn(drizzleWs(pool, { schema }) as unknown as Db);
  } finally {
    await pool.end();
  }
}
