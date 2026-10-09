import "./load-env";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import ws from "ws";
import { isLocalDatabaseUrl } from "../src/lib/db";

// Applies the committed SQL in drizzle/ to DATABASE_URL.
//
// Uses the WebSocket driver rather than neon-http on purpose: its migrator
// runs every pending migration inside one transaction, so a statement that
// fails halfway rolls the whole batch back instead of leaving the schema
// half-applied. The HTTP migrator runs statements one by one with no
// rollback. A localhost URL (local mode, see src/lib/db.ts) uses
// node-postgres, whose migrator is transactional too.
neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  if (isLocalDatabaseUrl(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await migratePg(drizzlePg(pool), { migrationsFolder: "./drizzle" });
    } finally {
      await pool.end();
    }
  } else {
    const pool = new Pool({ connectionString: url });
    try {
      await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    } finally {
      await pool.end();
    }
  }
  console.log("Migrations applied.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
