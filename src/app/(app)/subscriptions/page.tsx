import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { billAnchor } from "@/lib/recurring/links";
import { listAlerts, listCancelled, listRecurring } from "@/operations/recurring";
import { isFlagKind } from "@/lib/suspicious/checks";
import { read } from "@/operations/runtime";
import { AlertList } from "./alert-list";
import { CancelButton, CheckNow, StatusButtons, StillActiveButton } from "./controls";

// Subscriptions and recurring bills (#9): what's tracked, what was
// detected, and the alerts. Detection is rule-based and runs on read; the
// nightly sync raises alerts, and "Check now" does the same on demand.

export default async function SubscriptionsPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const [series, alerts, cancelled] = await Promise.all([read(db, listRecurring, {}), read(db, listAlerts, {}), read(db, listCancelled, {})]);
  // Suspicious-charge flags (#33) are alerts too, but they're answered in
  // the Inbox, not here.
  const open = alerts.filter((a) => !isFlagKind(a.kind));
  const tracked = series.filter((s) => s.status === "confirmed");
  // Ended (#83): went quiet, waiting for the owner to say cancelled or
  // still active. Everything else tracked is current, including a quiet
  // bill they've said is still active.
  const ended = tracked.filter((s) => s.ended);
  const current = tracked.filter((s) => !s.ended);
  const suggested = series.filter((s) => s.status === "suggested" && s.active);
  const dismissed = series.filter((s) => s.status === "dismissed");
  const yearly = current.reduce((sum, s) => sum + s.annualizedCents, 0);
  // At the yearly cost when cancelled, kept even once detection forgets it.
  const saved = cancelled.reduce((sum, c) => sum + c.annualizedCents, 0);
  const amount = (s: (typeof series)[number]) => `${s.variable ? "about " : ""}${formatCents(s.typicalCents)}`;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold">Subscriptions</h1>
          <CheckNow />
        </div>
        <p className="text-3xl font-semibold tabular-nums">
          {formatCents(yearly)}
          <span className="ml-2 text-base font-normal text-muted-foreground">a year, tracked</span>
        </p>
        {saved ? (
          <p className="text-sm">
            <span className="font-medium text-positive tabular-nums">{formatCents(saved)}</span>
            <span className="text-muted-foreground"> a year saved by cancelling</span>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Recurring charges are found by merchant, cadence and amount. Confirm the ones to track: they get a next-charge
          date, a yearly cost, and an alert if a charge goes missing. Mark one cancelled when you end it, and a charge
          after that raises an alert. Alerts are raised after each nightly sync.
        </p>
      </div>

      {open.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Alerts</h2>
          <AlertList alerts={open} />
        </section>
      ) : null}

      {ended.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Ended</h2>
          <p className="text-xs text-muted-foreground">
            These stopped charging. If you cancelled, mark it, and a charge after that raises an alert. If it&apos;s still
            active (a card problem, say), keep tracking it; this gap won&apos;t alert again.
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {ended.map((s) => (
              <li key={`${s.merchant}|${s.accountId}`} id={billAnchor(s.merchant, s.accountId)} className="flex scroll-mt-4 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{s.merchant}</span>
                  <span className="block text-xs text-muted-foreground">
                    Last {formatCents(s.latestCents)} on {s.lastOn} · {s.accountName} · next was due around {s.nextExpectedOn}
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-1">
                  {/* Cancelled after the last charge, most likely; editable. */}
                  <CancelButton merchant={s.merchant} accountId={s.accountId} today={today} defaultOn={s.lastOn} label="Mark cancelled…" primary />
                  <StillActiveButton merchant={s.merchant} accountId={s.accountId} />
                  <StatusButtons merchant={s.merchant} accountId={s.accountId} options={[{ label: "Stop tracking", status: null }]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Tracked</h2>
        {current.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing tracked yet. Confirm a suggestion below.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {current.map((s) => (
              <li
                key={`${s.merchant}|${s.accountId}`}
                id={billAnchor(s.merchant, s.accountId)}
                // Opened from a renewal alert (#84): the bill, marked.
                className="flex scroll-mt-4 flex-wrap items-center justify-between gap-2 px-3 py-2 target:bg-primary/10"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.merchant}</span>
                  <span className="block text-xs text-muted-foreground">
                    {amount(s)} {s.cadence} · {s.accountName} ·{" "}
                    {s.overdue ? `no charge since ${s.lastOn}, kept as still active` : `next around ${s.nextExpectedOn}`}
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
                  <span className="tabular-nums">{formatCents(s.annualizedCents)}/yr</span>
                  <CancelButton merchant={s.merchant} accountId={s.accountId} today={today} />
                  <StatusButtons merchant={s.merchant} accountId={s.accountId} options={[{ label: "Stop tracking", status: null }]} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {suggested.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Looks recurring</h2>
          <p className="text-xs text-muted-foreground">
            Confirm subscriptions and bills you want tracked. Dismiss anything that isn&apos;t one, like a transfer to
            savings; it won&apos;t be suggested or alerted on again.
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {suggested.map((s) => (
              <li key={`${s.merchant}|${s.accountId}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{s.merchant}</span>
                  <span className="block text-xs text-muted-foreground">
                    {amount(s)} {s.cadence} · {s.accountName} · {s.charges} charges since {s.firstOn}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  <StatusButtons merchant={s.merchant} accountId={s.accountId} options={[{ label: "Track", status: "confirmed", primary: true }]} />
                  {/* Already ended before it was ever tracked. */}
                  <CancelButton merchant={s.merchant} accountId={s.accountId} today={today} />
                  <StatusButtons merchant={s.merchant} accountId={s.accountId} options={[{ label: "Dismiss", status: "dismissed" }]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {cancelled.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Cancelled</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {cancelled.map((c) => (
              <li key={`${c.merchant}|${c.accountId}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{c.merchant}</span>
                  <span className="block text-xs text-muted-foreground">
                    {c.accountName} · cancelled {c.cancelledOn}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{formatCents(c.annualizedCents)}/yr</span>
                  <StatusButtons merchant={c.merchant} accountId={c.accountId} options={[{ label: "Track again", status: "confirmed" }]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {dismissed.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Dismissed ({dismissed.length})</summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {dismissed.map((s) => (
              <li key={`${s.merchant}|${s.accountId}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-muted-foreground">
                  {s.merchant} · {s.accountName}
                </span>
                <StatusButtons merchant={s.merchant} accountId={s.accountId} options={[{ label: "Undo", status: null }]} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
