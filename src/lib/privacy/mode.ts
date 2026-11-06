// Privacy mode (#363, epic #358): the app on a shared screen without the
// owner's finances. This file is the switch's shared parts, client-safe and
// pure; ./server.ts reads it on the server, and the provider in
// components/privacy hands it to client components.
//
// It's a cookie, per browser, not an account setting: the mode is about the
// screen in front of you, so turning it on here mustn't change what another
// device shows, and it can't be left on for someone else by accident. It
// isn't ledger data either, so it doesn't go through the operations layer
// or Activity.

export const PRIVACY_COOKIE = "privacy_mode";
// A year: it stays until it's turned off, in this browser.
export const PRIVACY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Whether a cookie value means on: "on", with this browser's salt for name
 * labels after a dot (#365), "on.k3j9…". Nothing else is. While it's on, a
 * bar on every page says so; the top bar's button shows it either way.
 */
export const privacyFromCookie = (value: string | undefined) => value === "on" || Boolean(value?.startsWith("on."));

/** The salt name labels are made with (#365): random, set each time the mode is turned on. */
export const saltFromCookie = (value: string | undefined) => (value?.startsWith("on.") ? value.slice(3) : "");

export const cookieFor = (salt: string) => `on.${salt}`;

/**
 * The shortcut: Option+Shift+P (Alt+Shift+P). Matched on the key's code,
 * since Option changes the character on a Mac keyboard. Not while typing in
 * a field, where it's text.
 */
export function isPrivacyShortcut(e: { code: string; altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; target?: unknown }): boolean {
  if (e.code !== "KeyP" || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return false;
  const tag = (e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined) ?? null;
  return !(tag && (tag.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(tag.tagName ?? "")));
}

export const PRIVACY_SHORTCUT_LABEL = "Option+Shift+P";
