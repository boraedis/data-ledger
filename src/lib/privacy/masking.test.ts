import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dollarFigure, formatCents, formatCentsPlain, MASKED_AMOUNT, maskMoneyText, moneyText } from "@/lib/money";
import { setBrowserPrivacy } from "@/lib/privacy/state";

// Masking amounts in privacy mode (#364): the formatter both ways, free
// text, and a guard over the source so no figure on screen skips the mask.
// Invented amounts only.

const g = globalThis as { window?: unknown };
afterEach(() => {
  setBrowserPrivacy(false);
  delete g.window;
});
const inBrowser = (on: boolean) => {
  g.window = {};
  setBrowserPrivacy(on);
};

describe("formatting", () => {
  it("is plain outside a render: a job, a route, a test, text for the model", () => {
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(dollarFigure("$1.2k")).toBe("$1.2k");
    expect(moneyText("Moved $42.50 to Groceries")).toBe("Moved $42.50 to Groceries");
  });

  it("masks every figure in the browser while the mode is on, and nothing when it's off", () => {
    inBrowser(true);
    expect(formatCents(123_456)).toBe(MASKED_AMOUNT);
    expect(formatCents(-5, "EUR")).toBe(MASKED_AMOUNT);
    expect(dollarFigure("$1.2k")).toBe(MASKED_AMOUNT);
    expect(moneyText("Moved $42.50 to Groceries")).toBe(`Moved ${MASKED_AMOUNT} to Groceries`);
    // What isn't for a screen stays exact.
    expect(formatCentsPlain(123_456)).toBe("$1,234.56");
    inBrowser(false);
    expect(formatCents(123_456)).toBe("$1,234.56");
  });

  it("finds amounts in free text, whatever shape they were written in", () => {
    expect(maskMoneyText("Set the Dining target to $400.00; was −$1,250 and +$3, about $1.2k")).toBe(
      `Set the Dining target to ${MASKED_AMOUNT}; was ${MASKED_AMOUNT} and ${MASKED_AMOUNT}, about ${MASKED_AMOUNT}`,
    );
    expect(maskMoneyText("No money here: 3 shares, 12%")).toBe("No money here: 3 shares, 12%");
  });
});

// --- The guard -----------------------------------------------------------------------

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
const source = ["src/app", "src/components", "src/lib", "src/operations"].flatMap(files);

describe("the source", () => {
  it("has every page read the mode before it renders, so its figures follow the cookie", () => {
    const pages = files("src/app/(app)").filter((p) => p.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(30);
    expect(pages.filter((p) => !readFileSync(p, "utf8").includes("await privacyMode()"))).toEqual([]);
  });

  it("writes no dollar figure by hand outside dollarFigure", () => {
    // "$" then a template value: an amount being written. Each must be inside dollarFigure(…) on its line.
    const offenders = source
      .filter((p) => !p.endsWith("lib/money.ts"))
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${p}:${i + 1}` }))
          .filter(({ line }) => line.includes("$" + "${") && !line.includes("dollarFigure(")),
      )
      .map((o) => o.at);
    expect(offenders).toEqual([]);
  });

  it("formats no currency of its own, and shows plain amounts only where nothing reaches a screen", () => {
    const own = source.filter((p) => !p.endsWith("lib/money.ts") && /style:\s*"currency"/.test(readFileSync(p, "utf8")));
    expect(own).toEqual([]);
    const plain = source.filter((p) => (p.startsWith("src/app") || p.startsWith("src/components")) && readFileSync(p, "utf8").includes("formatCentsPlain"));
    expect(plain).toEqual([]);
  });
});
