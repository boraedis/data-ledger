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
import { ACTIVITY_LABELS } from "@/lib/investments/activity";
import { listAccounts } from "@/operations/accounts";
import { TransactionEditor } from "./editor";
import { listPeople, transactionReimbursements } from "@/operations/reimbursements";
import { SharePanel } from "./share-panel";
import { manualMatches } from "@/operations/manual";
import { ManualNote } from "./manual-note";
import { ProvisionalNote } from "./provisional-note";
import { TransferNote } from "./transfer-note";

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
  const [cats, tagList, accts, peopleList, shared, merge] = await Promise.all([
    read(db, listCategories, {}),
    read(db, listTags, {}),
    read(db, listAccounts, {}),
    read(db, listPeople, {}),
    read(db, transactionReimbursements, { transactionId: txn.id }),
    txn.manual ? read(db, manualMatches, { transactionId: txn.id }) : Promise.resolve([]),
  ]);
  const otherAccount = txn.transfer ? accts.find((a) => a.id === txn.transfer!.accountId)?.name ?? "another account" : null;

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
            {txn.investmentActivity ? ` · ${ACTIVITY_LABELS[txn.investmentActivity]}` : ""}
          </p>
        </div>
        <p className={`shrink-0 text-xl tabular-nums ${txn.amountCents > 0 ? "text-positive" : ""}`}>
          {formatCents(txn.amountCents)}
        </p>
      </div>
      {txn.manual ? (
        <ManualNote
          txn={{ id: txn.id, postedOn: txn.postedOn, amountCents: txn.amountCents, description: txn.description }}
          candidates={merge[0]?.candidates ?? []}
          today={new Date().toISOString().slice(0, 10)}
        />
      ) : null}
      {txn.provisionalSource ? <ProvisionalNote transactionId={txn.id} source={txn.provisionalSource} /> : null}
      {txn.transfer ? (
        <TransferNote
          transactionId={txn.id}
          otherId={txn.transfer.transactionId}
          otherAccountName={otherAccount!}
          incoming={txn.amountCents > 0}
        />
      ) : txn.transferUnmatched ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Filed as a transfer, but its other half wasn&apos;t found: no matching amount {txn.amountCents > 0 ? "left" : "arrived in"} another of your
          accounts within 5 days. That&apos;s fine if the other account isn&apos;t connected. If it wasn&apos;t a transfer, file it as spending or
          income below, or it counts as neither.
        </p>
      ) : null}
      {txn.payStub ? (
        <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
          The deposit of the {txn.payStub.employer} pay stub dated {txn.payStub.payDate}: budgets and Cash flow count it as that paycheck&apos;s
          gross pay and deductions, not this amount on its own.{" "}
          <Link href="/pay" className="underline">
            See it on Pay
          </Link>
        </p>
      ) : txn.paycheckWithoutStub ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Looks like a paycheck, but no pay stub is linked to it, so it counts as this deposit only, without its taxes and deductions.{" "}
          <Link href="/pay" className="underline">
            Add or link its pay stub on Pay
          </Link>
        </p>
      ) : null}
      {/* Pending rows can be replaced when they post, so sharing waits. */}
      {!txn.pending && !txn.transfer ? (
        <SharePanel
          transactionId={txn.id}
          amountCents={txn.amountCents}
          people={peopleList.map((p) => ({ id: p.id, name: p.name }))}
          shares={shared.shares}
          covers={shared.covers}
        />
      ) : null}
      {/* Keyed on the amount: editing one added by hand resets the split form's defaults. */}
      <TransactionEditor key={`${txn.id}:${txn.amountCents}`} txn={txn} options={categoryOptions(cats)} knownTags={tagList.map((t) => t.name)} />
      <p className="text-xs text-muted-foreground">
        Every change here is in <Link href="/activity" className="underline">Activity</Link> and can be undone there.
      </p>
    </div>
  );
}
