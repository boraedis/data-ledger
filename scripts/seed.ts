import "./load-env";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/types";
import { isLocalDatabaseUrl } from "../src/lib/db";
import { applySeed } from "../src/lib/seed/apply";

// Fills DATABASE_URL with synthetic data. applySeed refuses if any real
// account is present; this extra check is a second, cheaper tripwire for
// the case that matters most.
neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing to seed with VERCEL_ENV=production");
  }

  const local = isLocalDatabaseUrl(url);
  const pool = local ? new pg.Pool({ connectionString: url, max: 1 }) : new Pool({ connectionString: url });
  try {
    const db = (local ? drizzlePg(pool as pg.Pool, { schema }) : drizzle(pool as Pool, { schema })) as unknown as Db;
    const result = await applySeed(db);
    console.log(`Seeded ${result.accounts} accounts and ${result.transactions} transactions.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
