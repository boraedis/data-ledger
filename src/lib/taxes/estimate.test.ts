import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, cadenceDays, estimateYear, remainingPaychecks, type EstimateStub } from "@/lib/taxes/estimate";

// Synthetic biweekly stubs: $4,000 gross, $400 federal, $248 Social
// Security, $58 Medicare, $100 pre-tax health, $200 401(k).
function stub(payDate: string, grossCents = 400_000): EstimateStub {
  return {
    payDate,
    periodStart: payDate,
    periodEnd: payDate,
    grossCents,
    lines: [
      { kind: "federal_income_tax", amountCents: 40_000 },
      { kind: "social_security", amountCents: 24_800 },
      { kind: "medicare", amountCents: 5_800 },
      { kind: "health_insurance", amountCents: 10_000 },
      { kind: "retirement_pretax", amountCents: 20_000 },
    ],
  };
}
const biweekly = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) => stub(new Date(Date.parse(from) + i * 14 * 86_400_000).toISOString().slice(0, 10)));

describe("pace", () => {
  it("reads the cadence from pay dates, or a lone stub's period", () => {
    expect(cadenceDays(biweekly("2026-01-09", 4))).toBe(14);
    expect(cadenceDays([{ ...stub("2026-01-15"), periodStart: "2026-01-01", periodEnd: "2026-01-15" }])).toBe(15);
  });

  it("counts the paychecks left in the year", () => {
    expect(remainingPaychecks("2026-12-11", 14, 2026)).toBe(1);
    expect(remainingPaychecks("2026-12-25", 14, 2026)).toBe(0);
  });
});

describe("estimateYear", () => {
  // 26 paychecks in 2026 starting Jan 9; 20 recorded, 6 to come.
  const stubs = biweekly("2026-01-09", 20);

  it("totals the year so far and projects the rest at the recent pace", () => {
    const e = estimateYear(2026, stubs)!;
    expect(e).toMatchObject({ stubCount: 20, cadenceDays: 14, remainingPaychecks: 6, missingEarlierPay: false });
    expect(estimateYear(2026, biweekly("2026-06-05", 3))!.missingEarlierPay).toBe(true);
    expect(e.gross).toEqual({ ytdCents: 8_000_000, projectedCents: 10_400_000 });
    expect(e.taxes.map((t) => [t.kind, t.ytdCents, t.projectedCents])).toEqual([
      ["federal_income_tax", 800_000, 1_040_000],
      ["social_security", 496_000, 644_800],
      ["medicare", 116_000, 150_800],
    ]);
    // Insurance and retirement, separately from taxes.
    expect(e.groups.map((g) => [g.group, g.projectedCents])).toEqual([
      ["insurance", 260_000],
      ["retirement", 520_000],
    ]);
  });

  it("estimates the federal balance from wages less pre-tax deductions and the standard deduction", () => {
    const e = estimateYear(2026, stubs)!;
    // 104,000 - 2,600 health - 5,200 401(k) = 96,200 wages; less 16,100.
    expect(e.federal).toMatchObject({ wagesCents: 9_620_000, deductionCents: 1_610_000, taxableIncomeCents: 8_010_000 });
    // 10% of 12,400 + 12% of 38,000 + 22% of 29,700 = 1,240 + 4,560 + 6,534.
    expect(e.federal!.liabilityCents).toBe(1_233_400);
    expect(e.federal!.balanceCents).toBe(1_040_000 - 1_233_400);
  });

  it("uses what the owner enters: status, other income, itemized deductions, credits, payments", () => {
    const e = estimateYear(2026, stubs, {
      ...DEFAULT_ASSUMPTIONS,
      filingStatus: "married_joint",
      otherIncomeCents: 100_000,
      itemizedDeductionsCents: 4_000_000,
      creditsCents: 200_000,
      otherPaymentsCents: 50_000,
    })!;
    expect(e.federal).toMatchObject({ itemized: true, taxableIncomeCents: 9_620_000 + 100_000 - 4_000_000, paidCents: 1_090_000 });
    // 10% of 24,800 + 12% of 32,400 = 2,480 + 3,888; less 2,000 credits.
    expect(e.federal!.liabilityCents).toBe(248_000 + 388_800 - 200_000);
  });

  it("checks Social Security and Medicare against the wages", () => {
    const { fica } = estimateYear(2026, stubs)!;
    // FICA wages: 104,000 - 2,600 health (the 401(k) is still FICA wages).
    expect(fica!.socialSecurity.expectedCents).toBe(Math.round(10_140_000 * 0.062));
    expect(fica!.medicare.expectedCents).toBe(Math.round(10_140_000 * 0.0145));
  });

  it("projects without an estimate for a year with no tax table, and is null with no stubs", () => {
    const e = estimateYear(2031, biweekly("2031-01-03", 3))!;
    expect(e.federal).toBeNull();
    expect(e.gross.ytdCents).toBe(1_200_000);
    expect(estimateYear(2026, [])).toBeNull();
  });
});

describe("employer-paid benefits (#92)", () => {
  // The same 20 biweekly stubs, now with a memo box: a $120 401(k) match,
  // a $50 HSA contribution from the employer, $9 of life insurance cost,
  // and $6 of imputed income for coverage over $50,000. Plus $75 of the
  // owner's own HSA contribution through payroll.
  const withBenefits = biweekly("2026-01-09", 20).map((s) => ({
    ...s,
    lines: [...s.lines, { kind: "hsa" as const, amountCents: 7_500 }],
    employer: [
      { kind: "retirement_match" as const, amountCents: 12_000 },
      { kind: "hsa" as const, amountCents: 5_000 },
      { kind: "life_insurance" as const, amountCents: 900 },
      { kind: "imputed_income" as const, amountCents: 600 },
    ],
  }));

  it("totals what the employer paid on top, imputed income apart", () => {
    const { employer } = estimateYear(2026, withBenefits)!;
    expect(employer.lines.map((l) => [l.kind, l.ytdCents, l.projectedCents])).toEqual([
      ["retirement_match", 240_000, 312_000],
      ["hsa", 100_000, 130_000],
      ["life_insurance", 18_000, 23_400],
    ]);
    expect(employer.total).toEqual({ ytdCents: 358_000, projectedCents: 465_400 });
    expect(employer.imputed).toEqual({ ytdCents: 12_000, projectedCents: 15_600 });
  });

  it("taxes imputed income as wages, for income tax and Social Security and Medicare", () => {
    const plain = estimateYear(2026, biweekly("2026-01-09", 20).map((s) => ({ ...s, lines: [...s.lines, { kind: "hsa" as const, amountCents: 7_500 }] })))!;
    const e = estimateYear(2026, withBenefits)!;
    expect(e.federal!.wagesCents - plain.federal!.wagesCents).toBe(15_600);
    // FICA wages: 104,000 gross + 156 imputed - 2,600 health - 1,950 HSA.
    expect(e.fica!.medicare.expectedCents).toBe(Math.round((10_400_000 + 15_600 - 260_000 - 195_000) * 0.0145));
    // The match, the HSA money and the life insurance cost are never wages here.
    expect(e.gross).toEqual(plain.gross);
  });

  it("measures your and your employer's HSA contributions against the year's limit", () => {
    // Projected: 26 x ($75 + $50) = $3,250.
    expect(estimateYear(2026, withBenefits)!.hsa).toMatchObject({ projectedCents: 325_000, limitCents: null });
    expect(estimateYear(2026, withBenefits, { ...DEFAULT_ASSUMPTIONS, hsaCoverage: "self" })!.hsa!.limitCents).toBe(440_000);
    expect(estimateYear(2026, withBenefits, { ...DEFAULT_ASSUMPTIONS, hsaCoverage: "family", hsaCatchUp: true })!.hsa!.limitCents).toBe(975_000);
    expect(estimateYear(2026, biweekly("2026-01-09", 3))!.hsa).toBeNull();
  });
});
