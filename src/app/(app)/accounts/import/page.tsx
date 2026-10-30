import Link from "next/link";
import { getDb } from "@/lib/db";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { listAccounts } from "@/operations/accounts";
import { read } from "@/operations/runtime";
import { ImportForm } from "./import-form";

// Backfilling older history from a bank's CSV export (#35): a one-time
// fill-in before the sync's window, not a way of keeping the ledger
// current. The file is read in memory and never stored.

// Applying runs the rules and the transfer matcher over a year of rows.
export const maxDuration = 120;

export default async function ImportHistoryPage(props: PageProps<"/accounts/import">) {
  const sp = await props.searchParams;
  // Checking first: it's where most history (and most of a year) lives.
  const order = ["checking", "credit", "savings", "payment_app", "loan", "other_asset"];
  const accts = (await read(getDb(), listAccounts, {}))
    .filter((a) => !a.manual && !INVESTMENT_KINDS.includes(a.kind))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  const asked = typeof sp.account === "string" && accts.some((a) => a.id === sp.account) ? sp.account : (accts[0]?.id ?? null);
  return (
    <div className="space-y-4">
      <Link href="/accounts" className="text-sm text-muted-foreground underline">
        ← Accounts
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Import older history</h1>
        <p className="text-sm text-muted-foreground">
          The bank sync reaches back about 90 days. For history before that, export a CSV from the bank&apos;s website and add it here, one
          account and one file at a time. The file is read and never stored. You&apos;ll see what it contains, and what looks like it&apos;s
          already here from the sync, before anything is added. One import is one entry in Activity, undone as a whole.
        </p>
      </div>
      {accts.length === 0 ? (
        <p className="text-muted-foreground">No bank, card or loan accounts yet. Connect one in Settings first.</p>
      ) : (
        <ImportForm accounts={accts.map((a) => ({ id: a.id, name: a.name }))} initialAccountId={asked!} />
      )}
    </div>
  );
}
