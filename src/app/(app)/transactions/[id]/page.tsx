import Link from "next/link";
import { notFound } from "next/navigation";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listTags } from "@/operations/tags";
import { getTransaction } from "@/operations/transactions";
import { NotFoundError } from "@/operations/tracked";
import { TransactionEditor } from "./editor";

export default async function TransactionPage(props: PageProps<"/transactions/[id]">) {
  const { id } = await props.params;
  const db = getDb();
  // A malformed id fails the operation's own uuid validation; treat that
  // the same as a missing transaction.
  const txn = await read(db, getTransaction, { transactionId: id }).catch((error) => {
    if (error instanceof NotFoundError || (error && typeof error === "object" && "issues" in error)) return null;
    throw error;
  });
  if (!txn) notFound();
  const [cats, tagList] = await Promise.all([read(db, listCategories, {}), read(db, listTags, {})]);

  return (
    <div className="space-y-4">
      <Link href="/transactions" className="text-sm text-muted-foreground underline">
        ← Transactions
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{txn.merchant ?? txn.description}</h1>
          <p className="break-words text-sm text-muted-foreground">{txn.description}</p>
          <p className="text-sm text-muted-foreground">
            {txn.postedOn} · {txn.accountName}
            {txn.pending ? " · pending" : ""}
          </p>
        </div>
        <p className={`shrink-0 text-xl tabular-nums ${txn.amountCents > 0 ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
          {formatCents(txn.amountCents)}
        </p>
      </div>
      <TransactionEditor txn={txn} options={categoryOptions(cats)} knownTags={tagList.map((t) => t.name)} />
      <p className="text-xs text-muted-foreground">
        Every change here is in <Link href="/activity" className="underline">Activity</Link> and can be undone there.
      </p>
    </div>
  );
}
