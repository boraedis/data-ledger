import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/db/schema";

// Lazily create the client on first real use rather than at import time:
// `next build` imports every route to inspect it without DATABASE_URL set,
// and a module-scope throw breaks the build (same lesson as Data Diary).
//
// neon-http is one HTTP round trip per query and has no interactive
// transactions. That's fine for auth; the operations layer (#3) needs a
// write and its command-log entry to commit together, and will decide
// whether to move to the WebSocket driver then.
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

export function getDb() {
  if (!cachedSql) {
    const url = process.env.DATABASE_URL;
    const problem = describeDatabaseUrlProblem(url);
    if (problem) throw new Error(problem);
    cachedSql = neon(url!);
  }
  return drizzle(cachedSql, { schema });
}
