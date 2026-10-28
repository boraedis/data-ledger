import Link from "next/link";
import { Sparkline } from "@/components/charts/sparkline";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { netWorthSummary } from "@/lib/net-worth";
import { latestDigest } from "@/lib/tally/digest";
import { budgetStatus } from "@/operations/budgets";
import { provisionalRows } from "@/operations/provisional";
import { listAlerts, listRecurring } from "@/operations/recurring";
import { owedToMe } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { inboxCount } from "@/operations/transactions";

// Home is the dashboard (#71): where things stand today, one card per
// area, each with its key figure and a link to the full page. Every figure
// comes from what those pages already read; nothing new is computed here,
// and nothing on this page goes to the model. Tally's note from last night
// (#11) stays on top.

const DAY_MS = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (on: string) => shortDate.format(new Date(`${on}T00:00:00Z`));

// How far ahead "upcoming" charges look, and how far back the trend goes.
const UPCOMING_DAYS = 14;
const TREND_DAYS = 90;

function Card({ title, href, cta, wide, children }: { title: string; href: string; cta: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-3 rounded-lg border bg-card p-4 ${wide ? "md:col-span-2" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg">{title}</h2>
        <Link href={href} className="shrink-0 text-sm text-muted-foreground hover:text-foreground">
          {cta} →
        </Link>
      </div>
      {children}
    </section>
  );
}

const Figure = ({ children }: { children: React.ReactNode }) => <p className="text-2xl font-semibold">{children}</p>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

export default async function HomePage() {
  const db = getDb();
  const today = new Date();
  const on = isoDay(today);
  const [digest, alerts, inbox, budgets, owed, alerted, recurring, worth] = await Promise.all([
    latestDigest(db),
    read(db, listAlerts, {}),
    inboxCount(db),
    read(db, budgetStatus, {}),
    read(db, owedToMe, {}),
    provisionalRows(db, on),
    read(db, listRecurring, {}),
    netWorthSummary(db, { today }),
  ]);

  const stale = alerted.filter((r) => r.stale).length;

  // This month's budgets: the targets on a monthly period, together.
  const monthly = budgets.targets.filter((t) => t.periodMonths === 1);
  const spent = monthly.reduce((s, t) => s + t.spentCents, 0);
  const available = monthly.reduce((s, t) => s + t.availableCents, 0);
  const elapsed = monthly[0]?.elapsedShare ?? 0;
  const over = budgets.targets.filter((t) => t.remainingCents < 0);

  // Net worth now, a month ago, and the last few months' shape.
  const trend = worth.series.filter((p) => p.on >= isoDay(new Date(today.getTime() - TREND_DAYS * DAY_MS)));
  const monthAgo = [...worth.series].reverse().find((p) => p.on <= isoDay(new Date(today.getTime() - 30 * DAY_MS)));
  const change = monthAgo ? worth.netCents - monthAgo.netCents : null;

  const horizon = isoDay(new Date(today.getTime() + UPCOMING_DAYS * DAY_MS));
  const upcoming = recurring
    .filter((r) => r.active && (r.status === "confirmed" || r.status === "suggested") && r.nextExpectedOn >= on && r.nextExpectedOn <= horizon)
    .sort((a, b) => a.nextExpectedOn.localeCompare(b.nextExpectedOn));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl">Today</h1>
        <p className="text-sm text-muted-foreground">{new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(today)}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Tally's note" href="/tally" cta="Ask a follow-up" wide>
          {digest ? (
            <>
              <p className="text-xs text-muted-foreground">Written {fmtDay(digest.on)}</p>
              <div className="whitespace-pre-wrap text-sm">{digest.content}</div>
            </>
          ) : (
            <Note>Tally writes a short note here each night after the bank sync: what changed, what&apos;s over, what needs you.</Note>
          )}
        </Card>

        <Card title="Inbox" href="/inbox" cta="Open">
          {inbox || stale ? (
            <>
              <Figure>{inbox}</Figure>
              <Note>
                {inbox === 1 ? "transaction" : "transactions"} to categorize
                {stale ? ` · ${stale} purchase alert${stale === 1 ? "" : "s"} the bank never reported` : ""}
              </Note>
            </>
          ) : (
            <Note>All caught up: everything is categorized.</Note>
          )}
        </Card>

        <Card title="This month's budgets" href="/budgets" cta="Budgets">
          {monthly.length ? (
            <>
              <Figure>
                {formatCents(spent)} <span className="text-base font-normal text-muted-foreground">of {formatCents(available)}</span>
              </Figure>
              <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={`${Math.round((spent / (available || 1)) * 100)}% spent, ${Math.round(elapsed * 100)}% of the month gone`}>
                <div className={`h-full rounded-full ${spent > available ? "bg-negative" : "bg-primary"}`} style={{ width: `${Math.min(100, (spent / (available || 1)) * 100)}%` }} />
                {/* Where an even pace would be today. */}
                <div className="absolute -top-1 h-4 w-0.5 bg-foreground/60" style={{ left: `calc(${Math.min(elapsed, 1) * 100}% - 1px)` }} />
              </div>
              <Note>
                {Math.round(elapsed * 100)}% of the month gone
                {over.length ? (
                  <>
                    {" · "}
                    <span className="text-negative">over in {over.map((t) => t.name).join(", ")}</span>
                  </>
                ) : (
                  " · nothing over"
                )}
              </Note>
            </>
          ) : (
            <Note>No monthly budgets yet. Set a target for a category, or for everything else, on Budgets.</Note>
          )}
        </Card>

        <Card title="Net worth" href="/net-worth" cta="Details">
          {worth.series.length ? (
            <>
              <Figure>{formatCents(worth.netCents)}</Figure>
              <Sparkline values={trend.map((p) => p.netCents)} label={`Net worth over the last ${TREND_DAYS} days`} />
              {change !== null ? (
                <Note>
                  <span className={change < 0 ? "text-negative" : "text-positive"}>
                    {change < 0 ? "−" : "+"}
                    {formatCents(Math.abs(change))}
                  </span>{" "}
                  in the last 30 days
                </Note>
              ) : null}
            </>
          ) : (
            <Note>Connect a bank in Settings; net worth builds from each day&apos;s balances.</Note>
          )}
        </Card>

        <Card title="Coming up" href="/subscriptions" cta="Subscriptions">
          {upcoming.length ? (
            <>
              <ul className="divide-y text-sm">
                {upcoming.slice(0, 5).map((r) => (
                  <li key={`${r.merchant}|${r.accountId}`} className="flex justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate">
                      <span className="text-muted-foreground">{fmtDay(r.nextExpectedOn)}</span> · {r.merchant}
                    </span>
                    <span className="shrink-0">{formatCents(r.latestCents)}</span>
                  </li>
                ))}
              </ul>
              <Note>
                {formatCents(upcoming.reduce((s, r) => s + r.latestCents, 0))} in the next {UPCOMING_DAYS} days
                {upcoming.length > 5 ? ` · ${upcoming.length - 5} more` : ""}
              </Note>
            </>
          ) : (
            <Note>No recurring charges expected in the next {UPCOMING_DAYS} days.</Note>
          )}
        </Card>

        <Card title="Alerts" href="/subscriptions" cta="Review">
          {alerts.length ? (
            <ul className="space-y-1.5 text-sm">
              {alerts.slice(0, 3).map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span>{a.title}</span>
                </li>
              ))}
              {alerts.length > 3 ? <li className="text-muted-foreground">and {alerts.length - 3} more</li> : null}
            </ul>
          ) : (
            <Note>No open alerts. Price rises, double charges and ended trials show up here.</Note>
          )}
        </Card>

        <Card title="Owed to you" href="/owed" cta="Owed">
          {owed.totalCents ? (
            <>
              <Figure>{formatCents(owed.totalCents)}</Figure>
              <Note>
                from {owed.people.length} {owed.people.length === 1 ? "person" : "people"}
                {owed.people[0] ? ` · most from ${owed.people[0].personName} (${formatCents(owed.people[0].totalCents)})` : ""}
              </Note>
            </>
          ) : (
            <Note>Nobody owes you anything. Share an expense from its transaction page to track it.</Note>
          )}
        </Card>
      </div>
    </div>
  );
}
