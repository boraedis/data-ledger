import { Pool, neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs } from "drizzle-orm/neon-serverless";
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

export function getDb() {
  if (!cachedSql) cachedSql = neon(databaseUrl());
  return drizzle(cachedSql, { schema });
}

/**
 * Runs `fn` with a database that supports transactions. The pool lives for
 * this call only: in serverless, a WebSocket pool must not outlive the
 * request that opened it (Neon's guidance), so it's opened and closed here.
 */
export async function withTransactionalDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    return await fn(drizzleWs(pool, { schema }) as unknown as Db);
  } finally {
    await pool.end();
  }
}
