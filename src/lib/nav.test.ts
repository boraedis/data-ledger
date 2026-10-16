import { describe, expect, it } from "vitest";
import { ACCOUNT_PAGES, SECTIONS, pageFor, sectionFor } from "@/lib/nav";

describe("navigation", () => {
  it("puts every page in exactly one place", () => {
    const hrefs = [...SECTIONS.flatMap((s) => s.pages.map((p) => p.href)), ...ACCOUNT_PAGES.map((p) => p.href)];
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("finds the section and page for a path, including nested pages", () => {
    expect(sectionFor("/")?.id).toBe("home");
    expect(sectionFor("/transactions/3f1c/quick")?.id).toBe("transactions");
    expect(pageFor("/transactions/3f1c")?.href).toBe("/transactions");
    expect(sectionFor("/owed")?.id).toBe("plan");
    expect(sectionFor("/pay")?.id).toBe("wealth");
    expect(pageFor("/pay/taxes")?.label).toBe("Taxes");
    // Home matches only itself, not every path.
    expect(sectionFor("/settings")).toBeNull();
    expect(pageFor("/settings")?.label).toBe("Settings");
    expect(pageFor("/nowhere")).toBeNull();
  });
});
