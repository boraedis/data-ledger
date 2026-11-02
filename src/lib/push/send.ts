import { eq } from "drizzle-orm";
import webpush, { WebPushError, type PushSubscription } from "web-push";
import { pushSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";

// Push notifications to the owner's devices (#29), sent by the app itself
// with Web Push. No notification service of our own sits in between. Each
// payload is encrypted to the device's own keys, so the browser's push
// service (Apple's, for an iPhone) delivers it without being able to read
// it. VAPID keys sign every request, so only this app can push to these
// subscriptions.
//
// Every flow that notifies goes through sendPush: nightly alerts, Apple
// Pay purchases (#32) and suspicious-charge flags (#33); email alerts (#31)
// next.

export type PushNotification = {
  // Shown on the lock screen, so keep it minimal: a merchant and an
  // amount, never balances or account numbers (callers' responsibility;
  // the lengths are capped here).
  title: string;
  body: string;
  // Where tapping it goes: a path in the app.
  url: string;
  // Notifications with the same tag replace each other on the device
  // instead of piling up.
  tag?: string;
};

const MAX_TITLE = 80;
const MAX_BODY = 180;

// How long the push service keeps trying a device that's off or asleep.
// A day: an alert older than that has lost its point, and Home still
// shows it.
const TTL_SECONDS = 24 * 60 * 60;

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  // A contact for the push services: mailto: or an https URL. Apple
  // rejects a localhost one.
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export const pushIsConfigured = () => pushConfig() !== null;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export type SendDeps = {
  send?: (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
};

export type SendResult = { sent: number; failed: number; removed: number };

/**
 * Sends one notification to every subscribed device. A device the push
 * service says is gone (404, 410: uninstalled, permission revoked) is
 * removed. Any other failure is recorded on the device and doesn't stop
 * the rest. Never throws for a delivery problem; returns what happened.
 */
export async function sendPush(db: Db, notification: PushNotification, deps: SendDeps = {}): Promise<SendResult> {
  const config = pushConfig();
  const result: SendResult = { sent: 0, failed: 0, removed: 0 };
  if (!config) return result;
  if (!notification.url.startsWith("/") || notification.url.startsWith("//")) throw new Error("A notification links to a path in the app");

  const devices = await db.select().from(pushSubscriptions);
  const payload = JSON.stringify({
    title: clip(notification.title, MAX_TITLE),
    body: clip(notification.body, MAX_BODY),
    url: notification.url,
    tag: notification.tag,
  });
  const send = deps.send ?? webpush.sendNotification;
  const options: webpush.RequestOptions = {
    TTL: TTL_SECONDS,
    vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
  };

  for (const device of devices) {
    try {
      await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, options);
      await db.update(pushSubscriptions).set({ lastSentAt: new Date(), lastError: null }).where(eq(pushSubscriptions.id, device.id));
      result.sent++;
    } catch (error) {
      const status = error instanceof WebPushError ? error.statusCode : null;
      if (status === 404 || status === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
        result.removed++;
        continue;
      }
      // Status and a short reason only: the push service's body can echo
      // request details, and nothing here needs it.
      const reason = status ? `HTTP ${status}` : error instanceof Error ? error.message.slice(0, 120) : "Unknown error";
      await db.update(pushSubscriptions).set({ lastError: reason }).where(eq(pushSubscriptions.id, device.id));
      console.error(`Push to a device failed: ${reason}`);
      result.failed++;
    }
  }
  return result;
}

export async function saveSubscription(db: Db, input: { endpoint: string; p256dh: string; auth: string; label: string }) {
  // The same device subscribing again (keys rotated, reinstalled) replaces
  // its row rather than adding a second.
  const [row] = await db
    .insert(pushSubscriptions)
    .values(input)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: input.p256dh, auth: input.auth, label: input.label, lastError: null } })
    .returning({ id: pushSubscriptions.id });
  return row.id;
}

export async function listDevices(db: Db) {
  return db
    .select({
      id: pushSubscriptions.id,
      label: pushSubscriptions.label,
      createdAt: pushSubscriptions.createdAt,
      lastSentAt: pushSubscriptions.lastSentAt,
      lastError: pushSubscriptions.lastError,
    })
    .from(pushSubscriptions)
    .orderBy(pushSubscriptions.createdAt);
}

/** Which saved device a browser's own subscription is, without sending endpoints to the page. */
export async function deviceIdFor(db: Db, endpoint: string): Promise<string | null> {
  const [row] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return row?.id ?? null;
}

export async function removeDevice(db: Db, id: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}
