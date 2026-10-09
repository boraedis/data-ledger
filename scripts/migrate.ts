import "./load-env";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

// Applies the committed SQL in drizzle/ to DATABASE_URL.
//
// Uses the WebSocket driver rather than neon-http on purpose: its migrator
// runs every pending migration inside one transaction, so a statement that
// fails halfway rolls the whole batch back instead of leaving the schema
// half-applied. The HTTP migrator runs statements one by one with no
// rollback.
neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
