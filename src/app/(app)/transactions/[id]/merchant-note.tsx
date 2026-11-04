import Link from "next/link";
import type { merchantExplanation } from "@/lib/merchants/trail";
import { MerchantFix } from "./merchant-fix";

// How this transaction's merchant was chosen (#290): where the name came
// from, what cleaning took out, the spelling that matched and its merchant,
// and every change since. Display only; folded away, since it's for tracing
// a surprise, not for every visit.

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const ACTORS: Record<string, string> = { user: "you", tally: "Tally", import: "an import", matcher: "the matcher", memory: "merchant memory", model: "the model" };
const by = (actor: string) => ACTORS[actor] ?? (actor.startsWith("rule:") ? "a rule" : actor);

type Info = NonNullable<Awaited<ReturnType<typeof merchantExplanation>>>;

const merchantLink = (m: { id: string; name: string | null } | null) =>
  !m ? "no merchant" : m.name ? <Link href={`/merchants/${m.id}`} className="underline">{m.name}</Link> : "a merchant since merged away";

export function MerchantNote({
  info,
  transactionId,
  merchants,
  similar,
}: {
  info: Info;
  transactionId: string;
  merchants: { id: string; name: string }[];
  similar: { transactions: number; alreadyChosen: number };
}) {
  const { explanation: e, stored, merchant, aliasMatched, pinned, trail } = info;
  const differs = stored !== null && stored !== e.name;
  return (
    <details className="rounded-lg border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Merchant: <span className="text-foreground">{merchant?.name ?? "none"}</span>
        {pinned ? " (chosen by you)" : ""} · how it was chosen, or change it
      </summary>
      <div className="mt-2 space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">From</dt>
          <dd className="min-w-0">
            {e.source === "payee" ? "the payee the bank's provider gave" : "the bank's description"}:{" "}
            <span className="break-all font-mono text-xs">{e.input}</span>
          </dd>
          <dt className="text-muted-foreground">Taken out</dt>
          <dd className="min-w-0">
            {e.fellBack ? (
              "Nothing: cleaning would have left no name, so the text is used as it is."
            ) : e.removed.length ? (
              <ul className="flex flex-wrap gap-1">
                {e.removed.map((r, i) => (
                  <li key={i} className="rounded border px-1.5 py-0.5 text-xs">
                    <span className="text-muted-foreground">{r.what}</span> <span className="font-mono">{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              "Nothing, apart from spacing and capitals."
            )}
          </dd>
          <dt className="text-muted-foreground">Name</dt>
          <dd>
            {stored ?? "None"}
            {differs ? (
              <span className="block text-xs text-muted-foreground">
                {pinned ? "Chosen by hand" : "Cleaning gives “" + e.name + "” now: the cleanup has changed since."}{" "}
                {!pinned ? (
                  <Link href="/merchants/cleanup" className="underline">
                    Clean up names
                  </Link>
                ) : null}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Merchant</dt>
          <dd>
            {merchantLink(merchant)}
            {merchant ? (
              <span className="block text-xs text-muted-foreground">
                {pinned ? "You chose it by hand; cleanups leave it alone." : aliasMatched ? `“${stored}” is one of its spellings.` : "Not by its spelling: the nightly run will link it up."}
              </span>
            ) : null}
          </dd>
        </dl>
        {trail.length ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Changes, oldest first, each in Activity:</p>
            <ol className="space-y-1">
              {trail.map((t) => (
                <li key={`${t.commandId}`} className="text-xs">
                  <span className="text-muted-foreground">{when.format(t.at)} · {by(t.actor)} · </span>
                  {t.fromName === null && t.from === null ? (
                    <>arrived as {t.toName ?? "no name"}, {merchantLink(t.to)}</>
                  ) : (
                    <>
                      {t.fromName !== t.toName ? `${t.fromName ?? "no name"} → ${t.toName ?? "no name"}, ` : ""}
                      {t.from?.id !== t.to?.id ? <>{merchantLink(t.from)} → {merchantLink(t.to)}</> : "same merchant"}
                    </>
                  )}
                  <span className="text-muted-foreground"> ({t.reason})</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No logged changes to its merchant: it&apos;s as it arrived, from before merchants were tracked.</p>
        )}
        <MerchantFix transactionId={transactionId} current={merchant?.name ?? null} pinned={pinned} merchants={merchants} similar={similar} />
      </div>
    </details>
  );
}
