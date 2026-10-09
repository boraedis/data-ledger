import { getDb } from "@/lib/db";
import { listCommands } from "@/operations/runtime";
import { CommandActions } from "./command-actions";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const statusStyle: Record<string, string> = {
  proposed: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  applied: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
  undone: "bg-muted text-muted-foreground line-through",
};

// Every write to the ledger, newest first: who did it, why, and what it
// touched. Proposals wait here for approval; applied writes can be undone.
export default async function ActivityPage() {
  const commands = await listCommands(getDb(), { limit: 100 });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Activity</h1>
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
                </div>
                <p>{c.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {c.actor} · {when.format(c.createdAt)}
                  {c.changes.length ? ` · ${c.changes.length} row${c.changes.length === 1 ? "" : "s"} changed` : ""}
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
