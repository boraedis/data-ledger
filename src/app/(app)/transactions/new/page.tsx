import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { AddForm } from "./add-form";

// Adding a transaction by hand (#64): money the bank feed doesn't show, such
// as a payment-app payment or cash. Into the accounts the money moves
// through: not manual accounts (balance only) or investment accounts.
export default async function NewTransactionPage() {
  const db = getDb();
  const [accts, cats] = await Promise.all([read(db, listAccounts, {}), read(db, listCategories, {})]);
  // Everyday accounts first, checking at the top: where most of these go.
  const order = ["checking", "payment_app", "credit", "savings", "loan"];
  const accounts = accts
    .filter((a) => !a.manual && !INVESTMENT_KINDS.includes(a.kind))
    .sort((a, b) => (order.indexOf(a.kind) + 1 || 99) - (order.indexOf(b.kind) + 1 || 99) || a.name.localeCompare(b.name));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <Link href="/transactions" className="text-sm text-muted-foreground underline">
        ← Transactions
      </Link>
      <h1 className="text-2xl font-semibold">Add a transaction</h1>
      <p className="max-w-lg text-sm text-muted-foreground">
        For money the bank feed doesn&apos;t show, such as a payment-app payment or cash. It&apos;s marked as added by hand. If the bank reports the
        same purchase later, you&apos;ll be asked to merge them, and until then only the bank&apos;s counts.
      </p>
      <AddForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} categories={categoryOptions(cats)} today={today} />
    </div>
  );
}
