import Link from "next/link";
import { ValueChart } from "@/components/charts/value-chart";
import { KIND_LABELS } from "@/lib/account-kinds";
import { periodLabel } from "@/lib/budgets/format";
import { getDb } from "@/lib/db";
import { loadGoalProgress, type GoalProgress } from "@/lib/goals/progress";
import { formatCents } from "@/lib/money";
import { isLiability } from "@/lib/net-worth";
import { listAccounts } from "@/operations/accounts";
import { budgetStatus } from "@/operations/budgets";
import { listGoals } from "@/operations/goals";
import { read } from "@/operations/runtime";
import { GoalEditor, GoalForm, RestoreGoal } from "./goal-form";

// Savings goals (#10): targets to build toward, with progress from linked
// balances and tagged transfers, and pace against the target date. Budget
// sinking funds use the same pace math (src/lib/pace.ts) and are listed
// here too, since they're savings goals by another name.

function statusLine(g: GoalProgress): { text: string; tone: string } {
  const s = g.status;
  switch (s.kind) {
    case "reached":
      return { text: "Reached", tone: "text-emerald-700 dark:text-emerald-400" };
    case "on_track":
      return { text: `On track (pace: ${formatCents(s.expectedCents)} by today)`, tone: "text-emerald-700 dark:text-emerald-400" };
    case "behind":
      return { text: `Behind by ${formatCents(s.shortCents)} (pace: ${formatCents(s.expectedCents)} by today)`, tone: "text-red-700 dark:text-red-400" };
    case "overdue":
      return { text: `Past its date, ${formatCents(g.targetCents - g.currentCents)} short`, tone: "text-red-700 dark:text-red-400" };
    case "no_date":
      return {
        text: s.projectedOn ? `At the last 90 days' pace, reached around ${s.projectedOn}` : "Not growing over the last 90 days",
        tone: "text-muted-foreground",
      };
  }
}

export default async function GoalsPage() {
  const db = getDb();
  const [active, archived, definitions, accts, budgets] = await Promise.all([
    loadGoalProgress(db),
    // All goals, archived included; the archived ones are picked out below.
    loadGoalProgress(db, { archived: true }),
    read(db, listGoals, { includeArchived: true }),
    read(db, listAccounts, {}),
    read(db, budgetStatus, {}),
  ]);
  const archivedOnly = archived.filter((g) => definitions.find((d) => d.id === g.id)?.archived);
  const choices = accts.filter((a) => !isLiability(a.kind)).map((a) => ({ id: a.id, name: a.name, kindLabel: KIND_LABELS[a.kind] }));
  const sinkingFunds = budgets.targets.filter((t) => t.setAsideMonthlyCents !== null);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Goals</h1>
        <p className="text-sm text-muted-foreground">
          Something to save toward. Progress comes from the balances of accounts you link, transfers you tag, or both.
          With a date, the pace is an even line from where you started to the target.
        </p>
      </div>

      {active.length === 0 ? <p className="text-muted-foreground">No goals yet.</p> : null}
      {active.map((g) => {
        const status = statusLine(g);
        const def = definitions.find((d) => d.id === g.id)!;
        const pct = Math.max(0, Math.min(1, g.share));
        return (
          <section key={g.id} className="space-y-3 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-medium">{g.name}</h2>
              <p className="tabular-nums">
                {formatCents(g.currentCents)} <span className="text-muted-foreground">of {formatCents(g.targetCents)}</span>
                {g.targetDate ? <span className="text-muted-foreground"> by {g.targetDate}</span> : null}
              </p>
            </div>
            <div className="h-2.5 rounded-sm bg-muted" aria-hidden>
              <div className="h-full rounded-sm bg-foreground/70" style={{ width: `${pct * 100}%` }} />
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-xs">
              <span className={status.tone}>{status.text}</span>
              <span className="text-muted-foreground tabular-nums">
                {Math.round(g.share * 100)}%
                {g.monthlyNeededCents !== null ? ` · ${formatCents(g.monthlyNeededCents)}/month to make it` : ""}
              </span>
            </div>
            {g.series.length > 1 ? (
              <ValueChart label={`${g.name} progress`} height={140} series={g.series.map((p) => ({ on: p.on, cents: p.cents }))} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Counting {[...g.accounts.map((a) => a.name), ...(g.tagName ? [`transfers tagged #${g.tagName}`] : [])].join(" + ")}
              {" · "}since {g.startOn}
            </p>
            <GoalEditor
              accounts={choices}
              initial={{ id: g.id, name: g.name, targetCents: g.targetCents, targetDate: g.targetDate, accountIds: def.accountIds, tagName: g.tagName }}
            />
          </section>
        );
      })}

      <section className="space-y-2 rounded-lg border p-3">
        <h2 className="text-lg font-medium">Add a goal</h2>
        <GoalForm accounts={choices} />
      </section>

      {sinkingFunds.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Sinking funds</h2>
          <p className="text-xs text-muted-foreground">
            Budget targets set aside month by month for a bigger, less frequent bill, on the same pace math as goals.
            Change them on{" "}
            <Link href="/budgets" className="underline">
              Budgets
            </Link>
            .
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {sinkingFunds.map((t) => (
              <li key={t.categoryId ?? "buffer"} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                <span>
                  {t.name} <span className="text-xs text-muted-foreground">({periodLabel(t.start, t.end)})</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Set aside {formatCents(t.setAsideMonthlyCents!)}/month · {formatCents(t.setAsideByNowCents ?? 0)} by now ·{" "}
                  {formatCents(t.spentCents)} of {formatCents(t.targetCents)} spent
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {archivedOnly.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Archived ({archivedOnly.length})</summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {archivedOnly.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-muted-foreground">
                  {g.name} · {formatCents(g.currentCents)} of {formatCents(g.targetCents)}
                </span>
                <RestoreGoal goalId={g.id} name={g.name} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
