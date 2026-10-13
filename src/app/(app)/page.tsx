import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { budgetStatus } from "@/operations/budgets";
import { listAlerts } from "@/operations/recurring";
import { owedToMe } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { inboxCount } from "@/operations/transactions";
import { AlertList } from "./subscriptions/alert-list";

// Home is the digest: what needs attention today. Alerts are raised by the
// nightly pipeline (#9); push or email delivery of the same digest is #29,
// which will read these same alerts.

export default async function HomePage() {
  const db = getDb();
  const [alerts, inbox, budgets, owed] = await Promise.all([
    read(db, listAlerts, {}),
    inboxCount(db),
    read(db, budgetStatus, {}),
    read(db, owedToMe, {}),
  ]);
  const over = budgets.targets.filter((t) => t.remainingCents < 0);

  const items = [
    inbox ? { href: "/inbox", text: `${inbox} transaction${inbox === 1 ? "" : "s"} to categorize` } : null,
    over.length
      ? { href: "/budgets", text: `Over budget: ${over.map((t) => `${t.name} by ${formatCents(-t.remainingCents)}`).join(", ")}` }
      : null,
    owed.totalCents ? { href: "/owed", text: `${formatCents(owed.totalCents)} owed to you` } : null,
  ].filter((i): i is { href: string; text: string } => Boolean(i));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Today</h1>
      {alerts.length === 0 && items.length === 0 ? (
        <p className="text-muted-foreground">Nothing needs you today.</p>
      ) : null}
      {alerts.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Alerts</h2>
          <AlertList alerts={alerts} />
        </section>
      ) : null}
      {items.length ? (
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.href}>
              <Link href={i.href} className="underline-offset-2 hover:underline">
                {i.text} →
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
