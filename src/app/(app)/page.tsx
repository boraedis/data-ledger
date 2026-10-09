import { count } from "drizzle-orm";
import { accounts, transactions } from "@/db/schema";
import { getDb } from "@/lib/db";

// Placeholder until budgets (#7) and the review inbox (#6) give the home
// page something real to show. The counts are here so a freshly seeded
// database is visibly wired up end to end.
export default async function HomePage() {
  const db = getDb();
  const [[accountCount], [transactionCount]] = await Promise.all([
    db.select({ value: count() }).from(accounts),
    db.select({ value: count() }).from(transactions),
  ]);
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Home</h1>
      <p className="text-muted-foreground">
        {accountCount.value} accounts · {transactionCount.value} transactions
      </p>
    </div>
  );
}
