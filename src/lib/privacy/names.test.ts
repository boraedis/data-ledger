import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cookieFor, privacyFromCookie, saltFromCookie } from "@/lib/privacy/mode";
import { labelFor, privateName, privateText } from "@/lib/privacy/names";
import { setBrowserPrivacy } from "@/lib/privacy/state";

// Names as neutral labels in privacy mode (#365), on invented names, and a
// guard over the source so no name field reaches a screen unlabelled.

const g = globalThis as { window?: unknown };
afterEach(() => {
  setBrowserPrivacy(false);
  delete g.window;
});

describe("a label", () => {
  it("is the same for the same name, however it's spaced or cased, and four consonants long", () => {
    const a = labelFor("merchant", "Corner Bakery", "s1");
    expect(a).toMatch(/^Merchant [BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(labelFor("merchant", "  corner   BAKERY ", "s1")).toBe(a);
  });

  it("gives nothing of the name away: not its length, and not across salts or kinds", () => {
    expect(labelFor("merchant", "Z", "s1").length).toBe(labelFor("merchant", "An Extremely Long Example Merchant Name", "s1").length);
    expect(labelFor("merchant", "Corner Bakery", "s2")).not.toBe(labelFor("merchant", "Corner Bakery", "s1"));
    expect(labelFor("person", "Alex", "s1")).toMatch(/^Person /);
    expect(labelFor("account", "Everyday Checking", "s1")).toMatch(/^Account /);
  });

  it("tells most names apart: a long list rarely shares one", () => {
    const names = Array.from({ length: 200 }, (_, i) => `Example Merchant ${i}`);
    expect(new Set(names.map((n) => labelFor("merchant", n, "s1"))).size).toBeGreaterThanOrEqual(199);
  });
});

describe("privateName and privateText", () => {
  it("are plain outside a render, and with the mode off", () => {
    expect(privateName("merchant", "Corner Bakery")).toBe("Corner Bakery");
    expect(privateText("Renamed Corner Bakery")).toBe("Renamed Corner Bakery");
    g.window = {};
    setBrowserPrivacy(false, "s1");
    expect(privateName("merchant", "Corner Bakery")).toBe("Corner Bakery");
  });

  it("label names and hide free text in the browser while it's on, with this browser's salt", () => {
    g.window = {};
    setBrowserPrivacy(true, "s1");
    expect(privateName("merchant", "Corner Bakery")).toBe(labelFor("merchant", "Corner Bakery", "s1"));
    expect(privateName("merchant", null)).toBeNull();
    expect(privateText("Renamed Corner Bakery to Corner Café")).toBe("Details hidden in privacy mode");
  });
});

describe("the cookie", () => {
  it("carries the salt after the mode, and an older plain \"on\" still counts as on", () => {
    expect(privacyFromCookie(cookieFor("k3j9"))).toBe(true);
    expect(saltFromCookie(cookieFor("k3j9"))).toBe("k3j9");
    expect(privacyFromCookie("on")).toBe(true);
    expect(saltFromCookie("on")).toBe("");
    expect(privacyFromCookie("onward")).toBe(false);
  });
});

// --- The guard -----------------------------------------------------------------------

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [path] : [];
  });

describe("the source", () => {
  it("shows no merchant, description, account, institution, employer, person or alias field without its label", () => {
    // A field rendered straight into JSX, or into a string the page shows. Keys, links and form values are data, not display.
    const FIELD = /\.(merchant|merchantName|description|accountName|displayName|institution|employer|personName|alias)\b/;
    const SHOWN = /(?<![=$\w])\{[\w.?!\[\]]+\.(merchant|merchantName|description|accountName|displayName|institution|employer|personName|alias)\}|\$\{[\w.?!\[\]]+\.(merchant|merchantName|description|accountName|displayName|institution|employer|personName|alias)\}/;
    const offenders = ["src/app", "src/components"]
      .flatMap(files)
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .map((line, i) => ({ line: line.replace(/key=\{`[^`]*`\}/g, ""), at: `${p}:${i + 1}` }))
          .filter(({ line }) => FIELD.test(line) && SHOWN.test(line)),
      )
      .map((o) => o.at);
    expect(offenders).toEqual([]);
  });
});
