import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { budgetStatus } from "@/operations/budgets";
import { listAlerts } from "@/operations/recurring";
import { provisionalRows } from "@/operations/provisional";
import { owedToMe } from "@/operations/reimbursements";
import { read } from "@/operations/runtime";
import { inboxCount } from "@/operations/transactions";
import { latestDigest } from "@/lib/tally/digest";
import { AlertList } from "./subscriptions/alert-list";

// Home is the digest: Tally's note from last night (#11), then what needs
// attention — alerts raised by the nightly pipeline (#9), the inbox, budgets
// over, what's owed. Push or email delivery is #29 and reads the same.

export default async function HomePage() {
  const db = getDb();
  const [digest, alerts, inbox, budgets, owed, alerted] = await Promise.all([
    latestDigest(db),
    read(db, listAlerts, {}),
    inboxCount(db),
    read(db, budgetStatus, {}),
    read(db, owedToMe, {}),
    provisionalRows(db, new Date().toISOString().slice(0, 10)),
  ]);
  const stale = alerted.filter((r) => r.stale).length;
  const over = budgets.targets.filter((t) => t.remainingCents < 0);

  const items = [
    inbox ? { href: "/inbox", text: `${inbox} transaction${inbox === 1 ? "" : "s"} to categorize` } : null,
    over.length
      ? { href: "/budgets", text: `Over budget: ${over.map((t) => `${t.name} by ${formatCents(-t.remainingCents)}`).join(", ")}` }
      : null,
    stale
      ? { href: "/inbox#alerts", text: `${stale} purchase alert${stale === 1 ? "" : "s"} the bank never reported` }
      : null,
    owed.totalCents ? { href: "/owed", text: `${formatCents(owed.totalCents)} owed to you` } : null,
  ].filter((i): i is { href: string; text: string } => Boolean(i));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Today</h1>
      {digest ? (
        <section className="space-y-1 rounded-lg border p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Tally&apos;s note · {digest.on} ·{" "}
            <Link href="/tally" className="underline">
              ask a follow-up
            </Link>
          </p>
          <div className="whitespace-pre-wrap">{digest.content}</div>
        </section>
      ) : null}
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
