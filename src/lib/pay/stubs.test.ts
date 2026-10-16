import { describe, expect, it } from "vitest";
import { depositCandidates, expandDeposit, groupOf, stubMismatch } from "@/lib/pay/stubs";

describe("stubMismatch", () => {
  it("passes a stub that adds up, and says by how much one doesn't", () => {
    expect(stubMismatch(300_000, [{ amountCents: 40_000 }, { amountCents: 15_000 }], 245_000)).toBeNull();
    expect(stubMismatch(300_000, [{ amountCents: 40_000 }], 245_000)).toMatch(/off by \$150\.00/);
  });
});

it("groups deductions so taxes are separate from insurance and retirement", () => {
  expect([groupOf("medicare"), groupOf("dental_insurance"), groupOf("retirement_pretax"), groupOf("fsa")]).toEqual(["tax", "insurance", "retirement", "other"]);
});

describe("depositCandidates", () => {
  it("wants exactly the net near the pay date, closest first", () => {
    const deposits = [
      { id: "far", postedOn: "2026-06-20", amountCents: 245_000 },
      { id: "late", postedOn: "2026-06-13", amountCents: 245_000 },
      { id: "on", postedOn: "2026-06-12", amountCents: 245_000 },
      { id: "other", postedOn: "2026-06-12", amountCents: 245_001 },
    ];
    expect(depositCandidates({ payDate: "2026-06-12", netCents: 245_000 }, deposits).map((d) => d.id)).toEqual(["on", "late"]);
  });
});

describe("expandDeposit", () => {
  const deposit = { categoryId: "paycheck", amountCents: 245_000 };
  it("counts gross pay and each placed deduction, adding up to the deposit", () => {
    const parts = expandDeposit(deposit, {
      grossCents: 300_000,
      lines: [
        { amountCents: 40_000, categoryId: "taxes" },
        { amountCents: 10_000, categoryId: "insurance" },
        { amountCents: 5_000, categoryId: null },
      ],
    });
    expect(parts).toEqual([
      { categoryId: "paycheck", amountCents: 295_000 },
      { categoryId: "taxes", amountCents: -40_000 },
      { categoryId: "insurance", amountCents: -10_000 },
    ]);
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(245_000);
  });

  it("falls back to the deposit alone when the stub no longer matches it", () => {
    expect(expandDeposit(deposit, { grossCents: 300_000, lines: [{ amountCents: 1, categoryId: "taxes" }] })).toEqual([deposit]);
  });
});
