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

export function getDb() {
  if (!cachedSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cachedSql = neon(url);
  }
  return drizzle(cachedSql, { schema });
}
