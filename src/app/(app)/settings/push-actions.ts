"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { deviceIdFor, removeDevice, saveSubscription, sendPush } from "@/lib/push/send";

// Push devices (#29). Each action re-checks the session: server actions
// are endpoints in their own right.

type Result = { error: string } | { ok: true; message?: string };

const subscription = z.object({
  endpoint: z.url().startsWith("https://").max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  label: z.string().trim().min(1).max(60),
});

export async function subscribeDevice(input: unknown): Promise<Result> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  const parsed = subscription.safeParse(input);
  if (!parsed.success) return { error: "That browser's subscription didn't look right" };
  const db = getDb();
  await saveSubscription(db, { endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth, label: parsed.data.label });
  revalidatePath("/settings");
  return { ok: true };
}

export async function thisDevice(endpoint: string): Promise<string | null> {
  if (!(await hasValidSession())) return null;
  return deviceIdFor(getDb(), endpoint);
}

export async function forgetDevice(id: string): Promise<Result> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  if (!z.uuid().safeParse(id).success) return { error: "Unknown device" };
  await removeDevice(getDb(), id);
  revalidatePath("/settings");
  return { ok: true };
}

export async function sendTest(): Promise<Result> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  // Nothing from the ledger in it: it only proves delivery.
  const result = await sendPush(getDb(), { title: "Data Ledger", body: "Test notification: this device will get alerts.", url: "/settings", tag: "test" });
  revalidatePath("/settings");
  if (result.sent === 0) return { error: result.failed ? "Sending failed; see the device list for the reason." : "No devices to send to." };
  return { ok: true, message: `Sent to ${result.sent} device${result.sent === 1 ? "" : "s"}${result.removed ? `; removed ${result.removed} that no longer exist` : ""}.` };
}
