import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "../src/db/schema";
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

  const pool = new Pool({ connectionString: url });
  try {
    const result = await applySeed(drizzle(pool, { schema }));
    console.log(`Seeded ${result.accounts} accounts and ${result.transactions} transactions.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
