import { and, gte, isNull } from "drizzle-orm";
import { alerts, pushSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import { pushIsConfigured, sendPush, type SendDeps } from "@/lib/push/send";
import { billHref } from "@/lib/recurring/links";
import { execute } from "@/operations/runtime";

// Nightly alerts (#9) as push notifications (#29): after the sync raises
// them, each new one reaches the owner's phone instead of waiting for Home
// to be opened.

// Only alerts raised recently. Turning notifications on for the first
// time shouldn't replay every alert ever raised; those are on Home.
const RECENT_MS = 48 * 60 * 60 * 1000;

// More than this many at once becomes one summary notification rather
// than a stack of them.
const MAX_SEPARATE = 3;

export async function notifyNewAlerts(db: Db, deps: SendDeps = {}, now = new Date()): Promise<{ notified: number }> {
  if (!pushIsConfigured()) return { notified: 0 };
  // No devices yet: leave the alerts unmarked rather than "sent" to no one.
  const [device] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).limit(1);
  if (!device) return { notified: 0 };

  const fresh = await db
    .select({ id: alerts.id, kind: alerts.kind, merchant: alerts.merchant, accountId: alerts.accountId, title: alerts.title, detail: alerts.detail })
    .from(alerts)
    .where(and(isNull(alerts.notifiedAt), isNull(alerts.dismissedAt), gte(alerts.createdAt, new Date(now.getTime() - RECENT_MS))))
    .orderBy(alerts.createdAt);
  if (fresh.length === 0) return { notified: 0 };

  let delivered = false;
  if (fresh.length <= MAX_SEPARATE) {
    for (const alert of fresh) {
      // A renewal heads-up (#84) opens the bill, where it can be cancelled.
      const url = alert.kind === "upcoming_renewal" && alert.accountId ? billHref(alert.merchant, alert.accountId) : "/";
      const result = await sendPush(db, { title: alert.title, body: alert.detail, url, tag: `alert-${alert.id}` }, deps);
      delivered ||= result.sent > 0;
    }
  } else {
    const result = await sendPush(
      db,
      { title: `${fresh.length} new alerts`, body: fresh.map((a) => a.title).join(" · "), url: "/", tag: "alerts" },
      deps,
    );
    delivered = result.sent > 0;
  }
  // Marked only when something reached a device, so a night with a push
  // outage tries again tomorrow (within the recent window).
  if (!delivered) return { notified: 0 };
  await execute(db, {
    operation: "alerts.markNotified",
    actor: "matcher",
    reason: `Sent ${fresh.length} alert${fresh.length === 1 ? "" : "s"} to your devices`,
    input: { alertIds: fresh.map((a) => a.id) },
  });
  return { notified: fresh.length };
}
