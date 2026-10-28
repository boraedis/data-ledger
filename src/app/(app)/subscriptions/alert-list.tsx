import Link from "next/link";
import { billHref } from "@/lib/recurring/links";
import { DismissAlert } from "./controls";

// Open alerts, shared by Subscriptions and the Home digest.

const KIND_LABEL: Record<string, string> = {
  price_increase: "Price increase",
  duplicate_charge: "Duplicate charge",
  overlapping_subscriptions: "Paying twice",
  trial_converted: "Trial ended",
  missing_charge: "Stopped charging",
  charged_after_cancel: "Charged after cancel",
  upcoming_renewal: "Renews soon",
};

export type AlertRow = { id: string; kind: string; title: string; detail: string; merchant: string; accountId: string | null; transactionId: string | null; occurredOn: string };

// The charge it's about, or for a renewal coming up, the bill itself.
const hrefFor = (a: AlertRow) =>
  a.transactionId ? `/transactions/${a.transactionId}` : a.kind === "upcoming_renewal" && a.accountId ? billHref(a.merchant, a.accountId) : null;

export function AlertList({ alerts }: { alerts: AlertRow[] }) {
  return (
    <ul className="space-y-2">
      {alerts.map((a) => (
        <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <span className="min-w-0">
            <span className="mr-2 rounded bg-warning/15 px-1.5 text-xs text-warning">{KIND_LABEL[a.kind] ?? a.kind}</span>
            {a.kind === "upcoming_renewal" && hrefFor(a) ? (
              // A plain link: the browser's own jump to the bill sets :target,
              // which marks the row; a client-side route change doesn't.
              <a href={hrefFor(a)!} className="font-medium underline-offset-2 hover:underline">
                {a.title}
              </a>
            ) : hrefFor(a) ? (
              <Link href={hrefFor(a)!} className="font-medium underline-offset-2 hover:underline">
                {a.title}
              </Link>
            ) : (
              <span className="font-medium">{a.title}</span>
            )}
            <span className="mt-0.5 block text-xs text-muted-foreground">{a.detail}</span>
          </span>
          <DismissAlert alertId={a.id} title={a.title} />
        </li>
      ))}
    </ul>
  );
}
