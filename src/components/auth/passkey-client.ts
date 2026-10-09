"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

// A cancelled or timed-out browser prompt surfaces as NotAllowedError; that's
// the owner changing their mind, not a failure worth a scary message.
function friendly(error: unknown): Error {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return new Error("Passkey prompt was cancelled.");
  }
  return error instanceof Error ? error : new Error("Something went wrong");
}

export async function signInWithPasskey(): Promise<void> {
  try {
    const optionsJSON = await postJson("/api/auth/login/options", {});
    const response = await startAuthentication({ optionsJSON });
    await postJson("/api/auth/login/verify", { response });
  } catch (error) {
    throw friendly(error);
  }
}

export async function registerPasskey(label: string, setupToken?: string): Promise<void> {
  try {
    const optionsJSON = await postJson("/api/auth/register/options", { setupToken });
    const response = await startRegistration({ optionsJSON });
    await postJson("/api/auth/register/verify", { setupToken, label, response });
  } catch (error) {
    throw friendly(error);
  }
}

export function defaultDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
