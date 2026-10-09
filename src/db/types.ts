import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

// Any Postgres drizzle instance over this schema: Neon (HTTP for plain
// reads, WebSocket where a transaction is needed) in the app, PGlite in
// tests. Operations take this, never a specific driver.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
