import Link from "next/link";
import { accounts as accountsTable } from "@/db/schema";
import { getDb } from "@/lib/db";
import { refreshPricesAfterResponse } from "@/lib/prices/after-response";
import { latestQuotes } from "@/lib/prices/quotes";
import { listManualPositions } from "@/operations/holdings";
import { listTrades, tradeCheck } from "@/operations/trades";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { AccountRow } from "./account-row";
import { AddManualAccount } from "./manual-account";

// Every account, grouped by institution, with the controls that decide what
// counts as spending. Edits go through the accounts.update operation, so
// each one is in Activity and can be undone there.
export default async function AccountsPage() {
  const db = getDb();
  const [rows, positions, quotes, tradeRows, mismatches] = await Promise.all([
    db.select().from(accountsTable).orderBy(accountsTable.institution, accountsTable.name),
    listManualPositions(db),
    latestQuotes(db, "crypto"),
    listTrades(db),
    tradeCheck(db),
  ]);
  // Which accounts take trades (#247): a manual asset account, or a synced brokerage or retirement one.
  const takesTrades = (a: (typeof rows)[number]) =>
    a.source === "manual" ? a.type !== "loan" && a.type !== "credit" : (INVESTMENT_KINDS as readonly string[]).includes(a.type);
  // Hand-entered positions show their market price (#229); refresh it after
  // the page is sent, if it's due.
  if (positions.length) refreshPricesAfterResponse();
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
    positions: positions
      .filter((p) => p.accountId === a.id)
      .map((p) => {
        const q = quotes.get(p.symbol.toUpperCase());
        return { ...p, market: q ? { price: q.price, asOf: q.asOf?.toISOString() ?? null, stale: q.stale } : null };
      }),
    trades: takesTrades(a) ? { rows: tradeRows.filter((t) => t.accountId === a.id), mismatches: mismatches.get(a.id) ?? [] } : undefined,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Only accounts that count toward budgets show up in spending. Brokerage, retirement, loan and asset accounts
          are left out by default so trades and transfers don&apos;t look like spending.
        </p>
        <p className="text-sm">
          <Link href="/accounts/import" className="underline">
            Import older history from a CSV export
          </Link>
          <span className="text-muted-foreground"> · for the time before the sync reaches back (about 90 days)</span>
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
