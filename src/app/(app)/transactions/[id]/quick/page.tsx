import { notFound } from "next/navigation";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { listCategories } from "@/operations/categories";
import { categoryChoices } from "@/operations/choices";
import { read } from "@/operations/runtime";
import { getTransaction } from "@/operations/transactions";
import { NotFoundError } from "@/operations/tracked";
import { QuickFile } from "./quick-file";

// Where a purchase notification lands (#34): one transaction, its likely
// categories as big buttons, filed in one tap. The full page
// (/transactions/[id]) has everything else.
export default async function QuickFilePage(props: PageProps<"/transactions/[id]/quick">) {
  const { id } = await props.params;
  const db = getDb();
  const txn = await read(db, getTransaction, { transactionId: id }).catch((error) => {
    if (error instanceof NotFoundError || (error && typeof error === "object" && "issues" in error)) return null;
    throw error;
  });
  if (!txn) notFound();
  const [choices, cats] = await Promise.all([read(db, categoryChoices, { transactionId: id }), read(db, listCategories, {})]);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));

  return (
    <QuickFile
      txn={{
        id: txn.id,
        merchant: txn.merchant ?? txn.description,
        amountCents: txn.amountCents,
        postedOn: txn.postedOn,
        accountName: txn.accountName,
        provisional: txn.provisionalSource,
        current: txn.isSplit ? "Split" : txn.categoryId ? (labelOf.get(txn.categoryId) ?? null) : null,
      }}
      choices={choices.map((c) => ({ ...c, label: labelOf.get(c.categoryId) ?? "" }))}
      options={options}
    />
  );
}
