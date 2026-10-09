import { describe, expect, it } from "vitest";
import { generateSeed } from "@/lib/seed/generate";

const endDate = new Date("2026-06-30T12:00:00Z");

describe("generateSeed", () => {
  it("is deterministic for the same inputs", () => {
    expect(generateSeed({ endDate })).toEqual(generateSeed({ endDate }));
  });

  it("covers roughly six months, all inside the window", () => {
    const { transactions } = generateSeed({ endDate });
    const dates = transactions.map((t) => t.postedOn).sort();
    expect(dates[0] >= "2025-12-30").toBe(true);
    expect(dates.at(-1)! <= "2026-06-30").toBe(true);
    expect(transactions.length).toBeGreaterThan(200);
  });

  it("uses integer cents and unique external ids", () => {
    const { transactions } = generateSeed({ endDate });
    expect(transactions.every((t) => Number.isInteger(t.amountCents) && t.amountCents !== 0)).toBe(true);
    expect(new Set(transactions.map((t) => t.externalId)).size).toBe(transactions.length);
  });

  it("includes the shapes later features depend on", () => {
    const { transactions } = generateSeed({ endDate });
    const streamflix = transactions.filter((t) => t.description.startsWith("STREAMFLIX"));
    expect(new Set(streamflix.map((t) => t.amountCents)).size).toBe(2); // price rise
    expect(transactions.some((t) => t.description.startsWith("PAYPEER PAYMENT FROM"))).toBe(true);
    expect(transactions.some((t) => t.description.includes("ANNUAL"))).toBe(true);
  });

  it("balances card payments on both sides", () => {
    const { transactions } = generateSeed({ endDate });
    const out = transactions.filter((t) => t.description === "PLACEHOLDER CARD CO PAYMENT");
    const into = transactions.filter((t) => t.description === "PAYMENT THANK YOU");
    expect(into.map((t) => t.amountCents).sort()).toEqual(out.map((t) => -t.amountCents).sort());
  });
});
