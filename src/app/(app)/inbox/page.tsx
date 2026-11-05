import { TallySummary } from "@/components/tally-summary";
import { categoryOptions } from "@/lib/categorize/labels";
import { autoApplyThreshold } from "@/lib/categorize/pipeline";
import { getDb } from "@/lib/db";
import { modelIsConfigured } from "@/lib/model/client";
import { merchantReview } from "@/lib/merchants/review";
import { latestDigest } from "@/lib/tally/digest";
import { summaryView } from "@/lib/tally/summary";
import { listAccounts } from "@/operations/accounts";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { listProvisional } from "@/operations/provisional";
import { listFlags } from "@/operations/suspicious";
import { listInbox } from "@/operations/transactions";
import { draftTotal } from "@/operations/trades";
import Link from "next/link";
import { FlagList } from "./flags";
import { Inbox } from "./inbox";
import { ProvisionalList } from "./provisional";
import { MergeSuggestions } from "../merchants/suggestions";
import { TypeSuggestions } from "../merchants/type-suggestions";

const LIMIT = 200;
// A few pairs at a time here; the rest are a click away on Merchants.
const MERCHANT_PAIRS = 3;
const written = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

// "Ask the model" may wait out a GPU cold start (~3.5 min).
export const maxDuration = 300;

// Everything the pipeline couldn't categorize on its own. Reads go through
// the same operations Tally will use, so what the owner sees here is what
// the assistant sees.
export default async function InboxPage() {
  const db = getDb();
  const [inbox, cats, accts, alerted, flags, digest, merchants, tradeDrafts] = await Promise.all([
    read(db, listInbox, { limit: LIMIT }),
    read(db, listCategories, {}),
    read(db, listAccounts, {}),
    read(db, listProvisional, {}),
    read(db, listFlags, {}),
    latestDigest(db),
    merchantReview(db, { pairs: MERCHANT_PAIRS }),
    draftTotal(db),
  ]);
  const merchantsWaiting = merchants.pairTotal + merchants.types.length;
  const accountName = new Map(accts.map((a) => [a.id, a.name]));
  const rows = inbox.map((r) => ({ ...r, accountName: accountName.get(r.accountId) ?? "" }));
  const options = categoryOptions(cats);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length === 0 && merchantsWaiting === 0 && tradeDrafts === 0
            ? "Nothing to review."
            : rows.length === 0
              ? `No transactions waiting for a category; ${merchantsWaiting} merchant suggestion${merchantsWaiting === 1 ? "" : "s"} below.`
              : `${rows.length}${rows.length === LIMIT ? "+" : ""} transactions waiting for a category. Only your rules file transactions on their own; suggestions from your history and the model wait here, pre-selected, for you to confirm one at a time or a set at once.`}
        </p>
      </div>
      {/* Tally's summary of the night's run (#214), where the triage starts.
          Only the newest shows; the nightly run rewrites it. */}
      {digest ? <TallySummary view={summaryView(digest.content, digest.facts)} written={written.format(digest.createdAt)} /> : null}
      {/* Above the inbox, which can run to hundreds of rows: a charge that
          may not be the owner's (#33) first, then stale alerts, since those
          wait on the owner. */}
      {flags.open.length || flags.suspicious.length ? <FlagList open={flags.open} suspicious={flags.suspicious} /> : null}
      {alerted.length ? <ProvisionalList rows={[...alerted].sort((a, b) => Number(b.stale) - Number(a.stale))} /> : null}
      {/* Merchants (#303): probably-the-same pairs and suggested types, which
          otherwise wait until the owner happens to open Merchants. The same
          actions as there, so a merge is the same undoable command and a
          rejected pair never comes back. Hidden when there's nothing. */}
      {merchants.pairs.length ? <MergeSuggestions suggestions={merchants.pairs} total={merchants.pairTotal} seeAll /> : null}
      {merchants.types.length ? <TypeSuggestions suggestions={merchants.types} /> : null}
      {/* Trades (#325): drafts inferred from what the brokerages report, to
          finish on the Trades page. A count and a link: finishing one needs
          the page's fields, not a one-click answer. Gone at zero. */}
      {tradeDrafts ? (
        <Link href="/trades#drafts" className="block rounded-lg border p-3 text-sm hover:bg-accent">
          <span className="font-medium">
            {tradeDrafts} {tradeDrafts === 1 ? "trade" : "trades"} to review
          </span>
          <span className="block text-xs text-muted-foreground">Inferred from what your brokerages report. Finish and confirm them on Trades.</span>
        </Link>
      ) : null}
      {options.length === 0 ? (
        <p className="text-muted-foreground">
          Create some categories first, under <a className="underline" href="/categories">Categories</a>.
        </p>
      ) : (
        <Inbox rows={rows} options={options} modelConfigured={modelIsConfigured()} confidentAt={autoApplyThreshold()} />
      )}
    </div>
  );
}
