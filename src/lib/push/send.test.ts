import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebPushError } from "web-push";
import { alerts, pushSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import { notifyNewAlerts } from "@/lib/push/alerts";
import { listDevices, saveSubscription, sendPush, type SendDeps } from "@/lib/push/send";
import { testDb } from "@/lib/test-utils/db";

// Push against a fake push service: what was sent, to whom, and what
// happens to devices when the service says no. All values synthetic.

const env = { VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: process.env.VAPID_SUBJECT };
let db: Db;
beforeEach(async () => {
  db = await testDb();
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  process.env.VAPID_SUBJECT = "mailto:owner@example.com";
});
afterEach(() => Object.assign(process.env, env));

const device = (n: number) => saveSubscription(db, { endpoint: `https://push.example.test/device-${n}`, p256dh: `key-${n}`, auth: `auth-${n}`, label: `Device ${n}` });

function fakeService(fail: Record<string, number> = {}) {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string; tag?: string } }[] = [];
  const deps: SendDeps = {
    send: async (subscription, payload) => {
      const status = fail[subscription.endpoint];
      if (status) throw new WebPushError("Rejected", status, {}, "", subscription.endpoint);
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    },
  };
  return { deps, sent };
}

describe("sendPush", () => {
  it("sends to every device, clipped, and records the delivery", async () => {
    await device(1);
    await device(2);
    const { deps, sent } = fakeService();
    const result = await sendPush(db, { title: "Patio Grill", body: "x".repeat(400), url: "/inbox", tag: "t" }, deps);
    expect(result).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example.test/device-1", "https://push.example.test/device-2"]);
    expect(sent[0].payload.body.length).toBeLessThanOrEqual(180);
    expect((await listDevices(db)).every((d) => d.lastSentAt)).toBe(true);
  });

  it("removes a device that's gone, and records other failures without stopping", async () => {
    await device(1);
    await device(2);
    await device(3);
    const { deps, sent } = fakeService({ "https://push.example.test/device-1": 410, "https://push.example.test/device-2": 500 });
    expect(await sendPush(db, { title: "t", body: "b", url: "/" }, deps)).toEqual({ sent: 1, failed: 1, removed: 1 });
    expect(sent).toHaveLength(1);
    const left = await listDevices(db);
    expect(left.map((d) => [d.label, d.lastError])).toEqual([
      ["Device 2", "HTTP 500"],
      ["Device 3", null],
    ]);
  });

  it("does nothing without VAPID keys, and only links inside the app", async () => {
    await device(1);
    const { deps, sent } = fakeService();
    await expect(sendPush(db, { title: "t", body: "b", url: "https://elsewhere.example" }, deps)).rejects.toThrow(/path in the app/);
    delete process.env.VAPID_PRIVATE_KEY;
    expect(await sendPush(db, { title: "t", body: "b", url: "/" }, deps)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sent).toEqual([]);
  });

  it("keeps one row per device when it subscribes again", async () => {
    await device(1);
    await saveSubscription(db, { endpoint: "https://push.example.test/device-1", p256dh: "new", auth: "new", label: "Device 1" });
    expect(await db.select().from(pushSubscriptions)).toEqual([expect.objectContaining({ p256dh: "new" })]);
  });
});

describe("notifyNewAlerts", () => {
  const raise = (n: number, createdAt = new Date()) =>
    db.insert(alerts).values({ kind: "duplicate_charge", dedupeKey: `k${n}`, merchant: "Ironworks Gym", title: `Alert ${n}`, detail: "A second $45.00 charge", occurredOn: "2026-07-01", createdAt });

  it("sends each new alert once, then marks it", async () => {
    await device(1);
    await raise(1);
    const { deps, sent } = fakeService();
    expect(await notifyNewAlerts(db, deps)).toEqual({ notified: 1 });
    expect(sent[0].payload).toMatchObject({ title: "Alert 1", url: "/" });
    expect(await notifyNewAlerts(db, deps)).toEqual({ notified: 0 });
    expect(sent).toHaveLength(1);
  });

  it("sums up a busy night, and skips old alerts", async () => {
    await device(1);
    for (const n of [1, 2, 3, 4]) await raise(n);
    await raise(5, new Date(Date.now() - 3 * 86_400_000));
    const { deps, sent } = fakeService();
    expect(await notifyNewAlerts(db, deps)).toEqual({ notified: 4 });
    expect(sent).toEqual([expect.objectContaining({ payload: expect.objectContaining({ title: "4 new alerts" }) })]);
  });

  it("leaves alerts unmarked when there's no device or nothing got through", async () => {
    await raise(1);
    const { deps } = fakeService();
    expect(await notifyNewAlerts(db, deps)).toEqual({ notified: 0 });
    await device(1);
    const failing = fakeService({ "https://push.example.test/device-1": 503 });
    expect(await notifyNewAlerts(db, failing.deps)).toEqual({ notified: 0 });
    expect(await notifyNewAlerts(db, deps)).toEqual({ notified: 1 });
  });
});
