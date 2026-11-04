import "./load-env";
import { writeFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import * as schema from "../src/db/schema";
import { accounts, holdingSnapshots, transactions } from "../src/db/schema";
import { isLocalDatabaseUrl } from "../src/lib/db";
import { INVESTMENT_KINDS } from "../src/lib/investments/activity";
import { renderSurvey, surveyBrokerages } from "../src/lib/trades/survey";

// The brokerage survey for the Trades epic (#316). Read-only: it selects
// from DATABASE_URL and writes nothing to it. Run it yourself, on your own
// machine:
//
//   npm run trades:survey                (prints the report)
//   npm run trades:survey -- out.md      (also writes it to out.md)
//
// It isn't meant for an agent to run against the real ledger: reading it
// would send ledger data to a hosted AI (AGENTS.md). The report has counts,
// shares and day spans per institution and masked description shapes, but
// read it before pasting it anywhere, #316 included. Write the file outside
// the repo, or delete it after: never commit it.
neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const local = isLocalDatabaseUrl(url);
  const pool = local ? new pg.Pool({ connectionString: url, max: 1 }) : new Pool({ connectionString: url });
  try {
    const db = local ? drizzlePg(pool as pg.Pool, { schema }) : drizzle(pool as Pool, { schema });
    // Synced investment accounts only: manual ones have no cash rows or snapshots (#231).
    const accts = await db
      .select({ id: accounts.id, institution: accounts.institution, type: accounts.type })
      .from(accounts)
      .where(and(inArray(accounts.type, [...INVESTMENT_KINDS]), ne(accounts.source, "manual")));
    const ids = accts.map((a) => a.id);
    const [rows, snaps] = ids.length
      ? await Promise.all([
          db.select({ accountId: transactions.accountId, postedOn: transactions.postedOn, description: transactions.description, payee: transactions.payee, memo: transactions.memo }).from(transactions).where(inArray(transactions.accountId, ids)),
          db
            .select({
              accountId: holdingSnapshots.accountId,
              on: holdingSnapshots.on,
              externalId: holdingSnapshots.externalId,
              symbol: holdingSnapshots.symbol,
              description: holdingSnapshots.description,
              shares: holdingSnapshots.shares,
              marketValueCents: holdingSnapshots.marketValueCents,
              costBasisCents: holdingSnapshots.costBasisCents,
            })
            .from(holdingSnapshots)
            .where(inArray(holdingSnapshots.accountId, ids)),
        ])
      : [[], []];
    const report = renderSurvey(surveyBrokerages({ accounts: accts, transactions: rows, snapshots: snaps }, new Date().toISOString().slice(0, 10)));
    console.log(report);
    const out = process.argv[2];
    if (out) writeFileSync(out, report + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
