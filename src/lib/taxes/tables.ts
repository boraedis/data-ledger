// Federal figures the tax estimate (#61) uses, per tax year. Public
// numbers, not the owner's: IRS Rev. Proc. 2024-40 (2025, with the
// standard deduction as raised by the One Big Beautiful Bill Act) and
// Rev. Proc. 2025-32 (2026); the Social Security wage base from the SSA's
// annual announcement. A year missing here gets withholding totals and a
// pace, but no estimate of what's owed: guessing brackets would be worse
// than saying nothing. Add the next year when the IRS publishes it.

export type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household";

// Upper bound of each bracket's taxable income, in dollars; the last is
// unbounded. Rates 10, 12, 22, 24, 32, 35, 37%.
export const RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

type YearTable = {
  brackets: Record<FilingStatus, number[]>;
  standardDeduction: Record<FilingStatus, number>;
  socialSecurityWageBase: number;
};

export const FEDERAL: Record<number, YearTable> = {
  2025: {
    brackets: {
      single: [11_925, 48_475, 103_350, 197_300, 250_525, 626_350],
      married_joint: [23_850, 96_950, 206_700, 394_600, 501_050, 751_600],
      married_separate: [11_925, 48_475, 103_350, 197_300, 250_525, 375_800],
      head_of_household: [17_000, 64_850, 103_350, 197_300, 250_500, 626_350],
    },
    standardDeduction: { single: 15_750, married_joint: 31_500, married_separate: 15_750, head_of_household: 23_625 },
    socialSecurityWageBase: 176_100,
  },
  2026: {
    brackets: {
      single: [12_400, 50_400, 105_700, 201_775, 256_225, 640_600],
      married_joint: [24_800, 100_800, 211_400, 403_550, 512_450, 768_700],
      married_separate: [12_400, 50_400, 105_700, 201_775, 256_225, 384_350],
      head_of_household: [17_700, 67_450, 105_700, 201_750, 256_200, 640_600],
    },
    standardDeduction: { single: 16_100, married_joint: 32_200, married_separate: 16_100, head_of_household: 24_150 },
    socialSecurityWageBase: 184_500,
  },
};

export const SOCIAL_SECURITY_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;

/** Federal income tax on a taxable income, in cents, for a year in the table; null for one that isn't. */
export function federalTax(year: number, status: FilingStatus, taxableCents: number): number | null {
  const table = FEDERAL[year];
  if (!table) return null;
  const tops = table.brackets[status].map((d) => d * 100);
  let tax = 0;
  let floor = 0;
  for (const [i, rate] of RATES.entries()) {
    const top = tops[i] ?? Infinity;
    if (taxableCents <= floor) break;
    tax += (Math.min(taxableCents, top) - floor) * rate;
    floor = top;
  }
  return Math.round(tax);
}
