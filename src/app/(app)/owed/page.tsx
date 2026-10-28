import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { AGING_BUCKETS, listPeople, owedToMe, proposals } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { AddPerson, ForgiveButton, PersonRow, ProposalActions } from "./controls";

// Owed to me (#8): payments that look like friends paying back (to
// confirm), what each person still owes with aging, and the people list.

export default async function OwedPage() {
  const db = getDb();
  const [owed, proposed, people] = await Promise.all([read(db, owedToMe, {}), read(db, proposals, {}), read(db, listPeople, {})]);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Owed to me</h1>
        <p className="text-3xl font-semibold tabular-nums">{formatCents(owed.totalCents)}</p>
        <p className="text-sm text-muted-foreground">
          Mark an expense as shared on its transaction page. Only your share counts toward budgets, and payments back are
          matched here instead of looking like income.
        </p>
      </div>

      {proposed.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Payments to match</h2>
          <p className="text-xs text-muted-foreground">
            Recognized by name, amount and timing. Nothing is matched until you confirm.
          </p>
          <ul className="space-y-2">
            {proposed.map((p) => (
              <li key={p.transactionId} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="min-w-0">
                    <Link href={`/transactions/${p.transactionId}`} className="font-medium underline-offset-2 hover:underline">
                      {formatCents(p.amountCents)} from {p.personName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {p.date} · {p.accountName} · {p.description}
                    </span>
                  </span>
                </div>
                <ul className="text-xs">
                  {p.allocations.map((a) => (
                    <li key={a.reimbursementId} className="flex justify-between gap-3">
                      <span className="truncate">
                        for {a.merchant} <span className="text-muted-foreground">({a.date})</span>
                      </span>
                      <span className="tabular-nums">{formatCents(a.amountCents)}</span>
                    </li>
                  ))}
                </ul>
                {p.kind === "more" ? (
                  <p className="text-xs text-muted-foreground">
                    {formatCents(p.unmatchedCents - p.allocations.reduce((s, a) => s + a.amountCents, 0))} more than they owe stays an
                    ordinary transaction.
                  </p>
                ) : null}
                <ProposalActions transactionId={p.transactionId} personName={p.personName} kind={p.kind} allocations={p.allocations} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">By person</h2>
        {owed.people.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody owes you anything right now.</p>
        ) : (
          // A table, scrolled sideways on a phone rather than squeezed: the
          // aging columns only mean something side by side.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm tabular-nums">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-normal">Person</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b.label} className="py-1 text-right font-normal">
                      {b.label}
                    </th>
                  ))}
                  <th className="py-1 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {owed.people.map((p) => (
                  <tr key={p.personId}>
                    <td className="py-1.5">{p.personName}</td>
                    {p.buckets.map((cents, i) => (
                      <td key={i} className={`py-1.5 text-right ${cents && i >= 2 ? "text-negative" : ""}`}>
                        {cents ? formatCents(cents) : "—"}
                      </td>
                    ))}
                    <td className="py-1.5 text-right font-medium">{formatCents(p.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {owed.items.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Open</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {owed.items.map((i) => (
              <li key={i.reimbursementId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">
                    {i.personName} ·{" "}
                    <Link href={`/transactions/${i.transactionId}`} className="underline-offset-2 hover:underline">
                      {i.merchant}
                    </Link>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {i.date} · {i.ageDays} days ago · owed {formatCents(i.owedCents)}
                    {i.receivedCents ? `, ${formatCents(i.receivedCents)} paid` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{formatCents(i.remainingCents)}</span>
                  <ForgiveButton reimbursementId={i.reimbursementId} summary={`Forgave ${i.personName}'s remaining ${formatCents(i.remainingCents)} for ${i.merchant}`} />
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Forgiving stops expecting the rest; the unpaid part counts as your own spending again.</p>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">People</h2>
        <p className="text-xs text-muted-foreground">
          Payments are recognized by name. Add the spellings payment apps use (&quot;A RIVERA&quot;) if they differ.
        </p>
        {people.length ? (
          <ul className="divide-y">
            {people.map((p) => (
              <PersonRow key={p.id} person={p} />
            ))}
          </ul>
        ) : null}
        <AddPerson />
      </section>
    </div>
  );
}
