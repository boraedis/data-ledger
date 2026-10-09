// Loads .env.local when present, so `npm run db:*` works the same as
// `next dev`. Variables already set in the shell win — loadEnvFile never
// overrides them — which is how a one-off `DATABASE_URL=... npm run
// db:migrate` against another database works. (Not `node --env-file-if-
// exists`: that flag needs a newer Node than the 20.18 floor.)
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on the shell environment.
}
