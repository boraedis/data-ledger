import Link from "next/link";
import { getDb } from "@/lib/db";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { listAccounts } from "@/operations/accounts";
import { read } from "@/operations/runtime";
import { TradeImportForm } from "./import-form";
import { privacyMode } from "@/lib/privacy/server";

// Importing a brokerage's CSV export (#357, epic #353): an investment
// account's trades and cash rows, linked, for the history before the sync
// or since. The file is read in memory and never stored.

export const maxDuration = 120;

export default async function TradeImportPage(props: PageProps<"/trades/import">) {
  await privacyMode();
  const sp = await props.searchParams;
  // Investment accounts, synced or manual: the ones that take trades from a brokerage export.
  const accts = (await read(getDb(), listAccounts, {}))
    .filter((a) => INVESTMENT_KINDS.includes(a.kind))
    .sort((a, b) => a.name.localeCompare(b.name));
  const asked = typeof sp.account === "string" && accts.some((a) => a.id === sp.account) ? sp.account : (accts[0]?.id ?? null);
  return (
    <div className="space-y-4">
      <Link href="/trades" className="text-sm text-muted-foreground underline">
        ← Trades
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Import from a brokerage export</h1>
        <p className="text-sm text-muted-foreground">
          Export your account&apos;s activity as a CSV from the brokerage&apos;s website and add it here, one account and one file at a time. Each
          row becomes its trade, its cash, or both, linked. The file is read and never stored. You&apos;ll see what each row adds, and what looks
          like it&apos;s already here, before anything is written. One import is one entry in Activity, undone as a whole.
        </p>
      </div>
      {accts.length === 0 ? (
        <p className="text-muted-foreground">No brokerage or retirement accounts yet. Connect one in Settings, or add one on Accounts.</p>
      ) : (
        <TradeImportForm accounts={accts.map((a) => ({ id: a.id, name: a.name }))} initialAccountId={asked!} />
      )}
    </div>
  );
}
