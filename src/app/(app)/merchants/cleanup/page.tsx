import Link from "next/link";
import { getDb } from "@/lib/db";
import { rederivePreviewRead } from "@/operations/merchants";
import { read } from "@/operations/runtime";
import { ChoiceList, CleanupForm } from "./apply";

// Re-running the merchant name cleanup over history (#288): what it would
// change, read before applying. Only the cleaned name moves (and with it the
// merchant); the bank's description is never touched. A new name joins the
// merchant the old one belonged to, so merges the owner made stay made.
// The owner ticks which changes to make and can rename any (#305); what
// they chose is remembered per raw text, listed under Your choices.

const MATCH: Record<string, string> = { equals: "is", contains: "contains", starts_with: "starts with" };

export default async function MerchantCleanupPage() {
  const preview = await read(getDb(), rederivePreviewRead, {});

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/merchants" className="text-sm text-muted-foreground hover:text-foreground">
          ← Merchants
        </Link>
        <h1 className="text-2xl font-semibold">Clean up merchant names</h1>
        <p className="text-sm text-muted-foreground">
          The way names are cleaned up has improved since some transactions came in: a town and state after the name, more
          payment-processor prefixes. This re-runs it over everything you have. The bank&apos;s descriptions stay as they are
          {preview.pinned ? `, and the ${preview.pinned} transaction${preview.pinned === 1 ? "" : "s"} whose merchant you chose by hand are left alone` : ""}.
        </p>
      </div>

      {preview.transactions === 0 ? (
        <p className="text-muted-foreground">Nothing to change: every name is already what the cleanup gives, or what you chose.</p>
      ) : (
        <>
          <p>
            <span className="font-medium tabular-nums">{preview.transactions}</span> transaction{preview.transactions === 1 ? "" : "s"} would get a different
            merchant name{preview.namesGone ? `, and ${preview.namesGone} name${preview.namesGone === 1 ? "" : "s"} would no longer be used` : ""}.
          </p>

          {preview.rules.length ? (
            <section className="space-y-2">
              <h2 className="text-lg font-medium">Rules that would match differently</h2>
              <p className="text-xs text-muted-foreground">Rules on the merchant name. Nothing is re-categorized now; the change shows from the next time they run.</p>
              <ul className="divide-y rounded-lg border text-sm">
                {preview.rules.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                    <span>
                      Merchant {MATCH[r.matchType] ?? r.matchType} &ldquo;{r.pattern}&rdquo;
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {r.gained ? `starts matching ${r.gained}` : ""}
                      {r.gained && r.lost ? ", " : ""}
                      {r.lost ? `stops matching ${r.lost}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {preview.series.length ? (
            <section className="space-y-2">
              <h2 className="text-lg font-medium">Recurring decisions on names that go away</h2>
              <p className="text-xs text-muted-foreground">
                What you said about these recurring charges is kept under the old name and won&apos;t follow to the new one: you may be asked about them again.
              </p>
              <ul className="divide-y rounded-lg border text-sm">
                {preview.series.map((s) => (
                  <li key={s.merchant} className="flex justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 truncate">{s.merchant}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <CleanupForm examples={preview.examples} unlisted={preview.unlisted} />
        </>
      )}

      {preview.choices.length ? <ChoiceList choices={preview.choices} /> : null}
    </div>
  );
}
