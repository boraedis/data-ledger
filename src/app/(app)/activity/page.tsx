import Link from "next/link";
import { getDb } from "@/lib/db";
import { merchantChanges } from "@/lib/merchants/trail";
import { listCommands } from "@/operations/runtime";
import { CommandActions } from "./command-actions";
import { privacyMode } from "@/lib/privacy/server";
import { privateText } from "@/lib/privacy/names";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const statusStyle: Record<string, string> = {
  proposed: "bg-warning/15 text-warning",
  applied: "bg-positive/15 text-positive",
  rejected: "bg-muted text-muted-foreground",
  undone: "bg-muted text-muted-foreground line-through",
};

// Every write to the ledger, newest first: who did it, why, and what it
// touched. Proposals wait here for approval; applied writes can be undone.
// Market price refreshes (#229) are left out unless asked for (?prices=1):
// one an hour would bury everything else. What Tally applied without asking
// (#59) is marked as such, apart from what the owner approved, and can be
// listed on its own (?auto=1). A change that moved transactions to another
// merchant (a re-run, merge, split or hand fix) says so (#290), so a
// surprising merchant can be traced here as well as from the transaction.
/** How many existing transactions a command gave another merchant or name; arrivals aren't counted. */
function merchantMoves(changes: Parameters<typeof merchantChanges>[0]) {
  const n = merchantChanges(changes).filter((m) => m.fromName !== null || m.fromId !== null).length;
  return n ? ` · ${n} transaction${n === 1 ? "'s" : "s'"} merchant changed` : "";
}

export default async function ActivityPage(props: PageProps<"/activity">) {
  await privacyMode();
  const sp = await props.searchParams;
  const showPrices = sp.prices === "1";
  const autoOnly = sp.auto === "1";
  const commands = await listCommands(getDb(), { limit: 100, excludeActors: showPrices ? [] : ["market"], autoAppliedOnly: autoOnly });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Activity</h1>
        <span className="flex gap-3 text-sm text-muted-foreground">
          <Link href={autoOnly ? "/activity" : "/activity?auto=1"} className="underline">
            {autoOnly ? "Everything" : "Only what Tally applied without asking"}
          </Link>
          <Link href={showPrices ? "/activity" : "/activity?prices=1"} className="underline">
            {showPrices ? "Hide price refreshes" : "Show price refreshes"}
          </Link>
        </span>
      </div>
      {commands.length === 0 ? (
        <p className="text-muted-foreground">No changes yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {commands.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-4 px-3 py-3 text-sm">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{c.undoOf ? `undo ${c.operation}` : c.operation}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${statusStyle[c.status]}`}>{c.status}</span>
                  {c.autoApplied ? <span className="rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground">auto-applied by Tally</span> : null}
                </div>
                <p>{privateText(c.reason)}</p>
                <p className="text-xs text-muted-foreground">
                  {c.actor} · {when.format(c.createdAt)}
                  {c.changes.length ? ` · ${c.changes.length} row${c.changes.length === 1 ? "" : "s"} changed` : ""}
                  {merchantMoves(c.changes)}
                  {c.decidedBy && c.decidedAt ? ` · ${c.status === "rejected" ? "rejected" : "approved"} by ${c.decidedBy}` : ""}
                </p>
              </div>
              <CommandActions commandId={c.id} status={c.status} isUndo={c.undoOf !== null} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
