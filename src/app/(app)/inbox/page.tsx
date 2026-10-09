import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listInbox } from "@/operations/transactions";
import { Inbox } from "./inbox";

const LIMIT = 200;

// Everything the pipeline couldn't categorize on its own. Reads go through
// the same operations Tally will use, so what the owner sees here is what
// the assistant sees.
export default async function InboxPage() {
  const db = getDb();
  const [inbox, cats, accts] = await Promise.all([
    read(db, listInbox, { limit: LIMIT }),
    read(db, listCategories, {}),
    read(db, listAccounts, {}),
  ]);
  const accountName = new Map(accts.map((a) => [a.id, a.name]));
  const rows = inbox.map((r) => ({ ...r, accountName: accountName.get(r.accountId) ?? "" }));
  const options = categoryOptions(cats);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length === 0
            ? "Nothing to review."
            : `${rows.length}${rows.length === LIMIT ? "+" : ""} transactions that rules and merchant memory couldn't categorize.`}
        </p>
      </div>
      {options.length === 0 ? (
        <p className="text-muted-foreground">
          Create some categories first, under <a className="underline" href="/categories">Categories</a>.
        </p>
      ) : (
        <Inbox rows={rows} options={options} />
      )}
    </div>
  );
}
