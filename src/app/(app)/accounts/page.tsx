import { accounts as accountsTable } from "@/db/schema";
import { getDb } from "@/lib/db";
import { AccountRow } from "./account-row";
import { AddManualAccount } from "./manual-account";

// Every account, grouped by institution, with the controls that decide what
// counts as spending. Edits go through the accounts.update operation, so
// each one is in Activity and can be undone there.
export default async function AccountsPage() {
  const rows = await getDb().select().from(accountsTable).orderBy(accountsTable.institution, accountsTable.name);
  // Manual accounts get their own section rather than mixing into an
  // institution's list: nothing syncs them, and that should be obvious.
  const manual = rows.filter((r) => r.source === "manual");
  const byInstitution = new Map<string, typeof rows>();
  for (const row of rows.filter((r) => r.source !== "manual")) {
    byInstitution.set(row.institution, [...(byInstitution.get(row.institution) ?? []), row]);
  }
  const rowData = (a: (typeof rows)[number]) => ({
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    kind: a.type,
    countsTowardBudgets: a.countsTowardBudgets,
    balanceCents: a.balanceCents,
    currency: a.currency,
    manual: a.source === "manual",
    balanceAt: a.balanceAt?.toISOString() ?? null,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Only accounts that count toward budgets show up in spending. Brokerage, retirement, loan and asset accounts
          are left out by default so trades and transfers don&apos;t look like spending.
        </p>
      </div>
      {byInstitution.size === 0 ? (
        <p className="text-muted-foreground">No bank accounts yet. Connect a bank under Settings.</p>
      ) : (
        [...byInstitution].map(([institution, accounts]) => (
          <section key={institution} className="space-y-2">
            <h2 className="text-lg font-medium">{institution}</h2>
            <ul className="divide-y rounded-lg border">
              {accounts.map((a) => (
                <AccountRow key={a.id} account={rowData(a)} />
              ))}
            </ul>
          </section>
        ))
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Manual</h2>
        {manual.length ? (
          <ul className="divide-y rounded-lg border">
            {manual.map((a) => (
              <AccountRow key={a.id} account={rowData(a)} />
            ))}
          </ul>
        ) : null}
        <AddManualAccount />
      </section>
    </div>
  );
}
