import { defineConfig } from "drizzle-kit";

// Used for `drizzle-kit generate` (schema diff → SQL file) and `studio`.
// Migrations are applied by scripts/migrate.ts, not `drizzle-kit migrate` or
// `push` — see the README's "Database migrations" section for why.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
