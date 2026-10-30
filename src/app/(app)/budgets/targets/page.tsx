import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { HISTORY_MONTHS } from "@/lib/budgets/engine";
import { scheduleLabel } from "@/lib/budgets/format";
import { targetAnchor } from "@/lib/budgets/overview";
import { budgetHref, budgetView } from "@/lib/budgets/tabs";
import { targetList } from "@/lib/budgets/target-list";
import { backdateRange, budgetHistory, listTargets, yearlyCharges } from "@/operations/budgets";
import { listCategories } from "@/operations/categories";
import { read } from "@/operations/runtime";
import { RebalanceForm, TargetForm, type TargetChoice } from "../forms";
import { BudgetTabs } from "../tabs";

// Targets (#145): every target and its amount, ended ones too, plus adding
// a target and moving budget between them — moved here from the Month view,
// which is now about how the month is going. Always today's targets:
// ?month= and ?gross= are only kept so switching tabs doesn't lose them.
// Changing or ending a target stays on its Month card, next to what's been
// spent against it.

const monthLabel = (date: string) =>
  new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export default async function BudgetTargetsPage(props: PageProps<"/budgets/targets">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  const db = getDb();
  const [versions, cats, history, yearly, range] = await Promise.all([
    read(db, listTargets, {}),
    read(db, listCategories, {}),
    // Suggested amounts (#106) come from net spend, since targets are net.
    read(db, budgetHistory, { on: today, gross: false }),
    // Yearly bills worth saving toward (#109).
    read(db, yearlyCharges, { on: today }),
    // How far back a new target can start (#130).
    read(db, backdateRange, {}),
  ]);
  const { active, ended } = targetList(versions, today);
  const histories = Object.fromEntries(
    history.map((h) => [h.categoryId ?? "", { averageCents: h.averageCents, months: h.months, overMonths: h.overMonths, comparedMonths: h.comparedMonths }]),
  );

  const targeted = new Set(active.map((t) => t.categoryId));
  const choices: TargetChoice[] = [
    ...(targeted.has(null) ? [] : [{ categoryId: null, name: "Everything else (buffer)" }]),
    ...categoryOptions(cats)
      .filter((o) => o.kind === "expense" && !targeted.has(o.id))
      .map((o) => ({ categoryId: o.id, name: o.label })),
  ];
  // A card is editable on this month only, so Edit opens this month's.
  const cardHref = (categoryId: string | null) => `${budgetHref("/budgets", { ...view, month: view.thisMonth })}#${targetAnchor(categoryId)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Targets</h1>
        <BudgetTabs current="targets" view={view} />
      </div>

      {active.length === 0 ? (
        <p className="text-muted-foreground">
          No targets yet. A good start: a buffer for everything, then targets for the few categories you actually want to watch.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {active.map((t) => (
            <li key={t.categoryId ?? "buffer"} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0">
                <span className="block font-medium">{t.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {[
                    `since ${monthLabel(t.since)}`,
                    t.changes ? `changed ${t.changes === 1 ? "once" : `${t.changes} times`}` : null,
                    t.rollover ? "rolls over" : null,
                    t.sinkingFund ? "saved toward monthly" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex items-baseline gap-3">
                <span className="tabular-nums">
                  {formatCents(t.amountCents)} <span className="text-muted-foreground">{scheduleLabel(t.periodMonths)}</span>
                </span>
                <Link href={cardHref(t.categoryId)} className="text-muted-foreground underline hover:text-foreground">
                  Edit
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}

      {active.length >= 2 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Move budget this period</h2>
          <p className="text-xs text-muted-foreground">
            Shifts money between two targets for the current period only; both targets stay as they are.
          </p>
          <RebalanceForm targets={active.map((t) => ({ categoryId: t.categoryId, name: t.name }))} />
        </section>
      ) : null}

      {choices.length ? (
        <section className="space-y-2 rounded-lg border p-3">
          <h2 className="text-lg font-medium">Add a target</h2>
          <TargetForm
            choices={choices}
            histories={histories}
            suggestFrom={histories}
            windowMonths={HISTORY_MONTHS}
            yearly={yearly.filter((y) => choices.some((c) => c.categoryId === y.categoryId))}
            backdate={range}
          />
        </section>
      ) : null}

      {ended.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Ended</h2>
          <p className="text-xs text-muted-foreground">Their history stays; the Year view still shows the months they had a target.</p>
          <ul className="divide-y rounded-lg border text-sm">
            {ended.map((t) => (
              <li key={t.categoryId ?? "buffer"} className="flex justify-between gap-3 px-3 py-1.5">
                <span className="truncate">{t.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {t.lastAmountCents !== null ? `${formatCents(t.lastAmountCents)}, ` : ""}none from {monthLabel(t.endedOn)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Every change is in <Link href="/activity" className="underline">Activity</Link> and can be undone there.
      </p>
    </div>
  );
}
