import { describe, expect, it } from "vitest";
import { isPrivacyShortcut, privacyFromCookie } from "@/lib/privacy/mode";

// Privacy mode's switch (#363): the cookie's reading and the shortcut.

const key = (over: Partial<Parameters<typeof isPrivacyShortcut>[0]> = {}) => ({ code: "KeyP", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...over });

describe("the cookie", () => {
  it("is on only when it says so", () => {
    expect(privacyFromCookie("on")).toBe(true);
    for (const v of [undefined, "", "off", "ON", "true"]) expect(privacyFromCookie(v)).toBe(false);
  });
});

describe("the shortcut", () => {
  it("is Option+Shift+P, by key code, so Option's character on a Mac doesn't matter", () => {
    expect(isPrivacyShortcut(key())).toBe(true);
    expect(isPrivacyShortcut(key({ shiftKey: false }))).toBe(false);
    expect(isPrivacyShortcut(key({ altKey: false }))).toBe(false);
    expect(isPrivacyShortcut(key({ metaKey: true }))).toBe(false);
    expect(isPrivacyShortcut(key({ code: "KeyO" }))).toBe(false);
  });

  it("isn't taken while typing in a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isPrivacyShortcut(key({ target: { tagName } }))).toBe(false);
    expect(isPrivacyShortcut(key({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
    expect(isPrivacyShortcut(key({ target: { tagName: "BODY" } }))).toBe(true);
  });
});
