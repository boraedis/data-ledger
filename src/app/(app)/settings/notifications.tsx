"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { forgetDevice, sendTest, subscribeDevice, thisDevice } from "./push-actions";

// Notifications on this device (#29). An iPhone only offers push to the
// app once it's on the home screen, so on iOS in Safari this explains how
// to install it instead of offering a button that can't work.

type Device = { id: string; label: string; added: string; lastSent: string | null; lastError: string | null };

type Support = "checking" | "ready" | "install-first" | "unsupported";

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** "iPhone", "Mac · Safari": enough to tell devices apart. Never sent anywhere but this app. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  if (device === "iPhone" || device === "iPad") return device;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${device} · ${browser}`;
}

export function Notifications({ publicKey, devices }: { publicKey: string | null; devices: Device[] }) {
  const [support, setSupport] = useState<Support>("checking");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        // iOS Safari has no PushManager until the app is on the home screen.
        setSupport(ios && !installed ? "install-first" : "unsupported");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const existing = await registration.pushManager.getSubscription();
      setSubscription(existing);
      if (existing) setCurrentId(await thisDevice(existing.endpoint));
      setSupport("ready");
    })().catch(() => setSupport("unsupported"));
  }, []);

  const report = (result: { error: string } | { ok: true; message?: string }) =>
    setMessage("error" in result ? { text: result.error, error: true } : result.message ? { text: result.message, error: false } : null);

  const enable = () =>
    startTransition(async () => {
      if (!publicKey) return;
      setMessage(null);
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage({ text: "Notifications weren't allowed. Turn them on for this app in the device's settings, then try again.", error: true });
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
        const json = sub.toJSON();
        const result = await subscribeDevice({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
        report(result);
        if (!("error" in result)) {
          setSubscription(sub);
          setCurrentId(await thisDevice(sub.endpoint));
        }
      } catch (error) {
        setMessage({ text: error instanceof Error ? `Couldn't turn on notifications: ${error.message}` : "Couldn't turn on notifications.", error: true });
      }
    });

  const forget = (id: string) =>
    startTransition(async () => {
      // Removing this device also unsubscribes the browser, so it stops
      // receiving at once rather than at the next failed send.
      if (id === currentId && subscription) {
        await subscription.unsubscribe().catch(() => undefined);
        setSubscription(null);
        setCurrentId(null);
      }
      report(await forgetDevice(id));
    });

  return (
    <div className="space-y-3 text-sm">
      {!publicKey ? (
        <p className="text-muted-foreground">
          Not set up: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT aren&apos;t set (see README, &quot;Push notifications&quot;).
        </p>
      ) : support === "install-first" ? (
        <p className="text-muted-foreground">
          On an iPhone, notifications work once Data Ledger is on your home screen: tap Share, then <span className="font-medium">Add to Home Screen</span>,
          open it from there and come back to Settings.
        </p>
      ) : support === "unsupported" ? (
        <p className="text-muted-foreground">This browser can&apos;t receive push notifications.</p>
      ) : support === "ready" ? (
        subscription && currentId ? (
          <p>This device gets notifications.</p>
        ) : (
          <Button size="sm" disabled={pending} onClick={enable}>
            Turn on notifications for this device
          </Button>
        )
      ) : null}

      {devices.length ? (
        <ul className="divide-y rounded-lg border">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block">
                  {d.label}
                  {d.id === currentId ? <span className="text-muted-foreground"> · this device</span> : null}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {d.lastError ? `Last send failed (${d.lastError})` : d.lastSent ? `Last notified ${d.lastSent}` : `Added ${d.added}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => forget(d.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {devices.length ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => report(await sendTest()))}>
          Send a test notification
        </Button>
      ) : null}
      {message ? <p className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>{message.text}</p> : null}
    </div>
  );
}
