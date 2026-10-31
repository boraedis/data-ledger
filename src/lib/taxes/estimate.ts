import { employerKindLabel, groupOf, kindLabel, type EmployerPayKind, type PayLineGroup, type PayLineKind } from "@/lib/pay/stubs";
import { FEDERAL, HSA_CATCH_UP, HSA_LIMITS, MEDICARE_RATE, SOCIAL_SECURITY_RATE, federalTax, type FilingStatus } from "@/lib/taxes/tables";

// The year's tax position from the owner's own pay stubs (#61): what's been
// withheld, where withholding is heading at the current pace, and roughly
// what that leaves owed or refunded. An estimate from their numbers, not
// tax advice: no credits it isn't told about, no state income tax (fifty
// sets of rules), no Additional Medicare Tax. Pure, so every figure is
// tested; computed on read, so editing a stub or an assumption shows at once.

export type EstimateStub = {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  lines: { kind: PayLineKind; amountCents: number }[];
  // Paid by the employer on top (#92), from the stub's memo box.
  employer?: { kind: EmployerPayKind; amountCents: number }[];
  // A bonus or other one-off pay (#113): in the year to date, not the pace.
  oneTime?: boolean;
};

export type Assumptions = {
  filingStatus: FilingStatus;
  otherIncomeCents: number;
  itemizedDeductionsCents: number | null;
  creditsCents: number;
  otherPaymentsCents: number;
  // Sets the year's HSA limit (#92); null when there's no HSA-eligible plan.
  hsaCoverage: "self" | "family" | null;
  hsaCatchUp: boolean;
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  filingStatus: "single",
  otherIncomeCents: 0,
  itemizedDeductionsCents: null,
  creditsCents: 0,
  otherPaymentsCents: 0,
  hsaCoverage: null,
  hsaCatchUp: false,
};

const TAX_KINDS: PayLineKind[] = ["federal_income_tax", "state_income_tax", "local_income_tax", "social_security", "medicare", "state_disability"];

// Deductions usually taken before federal income tax (401(k), HSA, FSA,
// and insurance through a cafeteria plan), and the subset also taken
// before Social Security and Medicare (everything but the 401(k)).
const PRE_INCOME_TAX: PayLineKind[] = ["retirement_pretax", "hsa", "fsa", "health_insurance", "dental_insurance", "vision_insurance"];
const PRE_FICA: PayLineKind[] = ["hsa", "fsa", "health_insurance", "dental_insurance", "vision_insurance"];

// How many recent pay stubs set "the current pace": enough to smooth one
// odd paycheck, few enough to follow a raise.
export const PACE_STUBS = 3;

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/** Days between paychecks: the usual gap between pay dates, or a single stub's own period. */
export function cadenceDays(stubs: EstimateStub[]): number {
  const dates = stubs.map((s) => s.payDate).sort();
  const gaps = dates.slice(1).map((d, i) => days(dates[i], d)).filter((g) => g > 0);
  const raw = gaps.length ? median(gaps) : days(stubs[0].periodStart, stubs[0].periodEnd) + 1;
  return Math.min(Math.max(raw, 7), 31);
}

/** Paychecks still to come this year after the last one, at that cadence. */
export function remainingPaychecks(lastPayDate: string, cadence: number, year: number): number {
  const yearEnd = Date.parse(`${year}-12-31`);
  let count = 0;
  for (let next = Date.parse(lastPayDate) + cadence * DAY_MS; next <= yearEnd; next += cadence * DAY_MS) count++;
  return count;
}

export type TaxEstimate = ReturnType<typeof estimateYear>;

export function estimateYear(year: number, stubs: EstimateStub[], assumptions: Assumptions = DEFAULT_ASSUMPTIONS) {
  const own = stubs.filter((s) => s.payDate.startsWith(`${year}-`)).sort((a, b) => a.payDate.localeCompare(b.payDate));
  if (own.length === 0) return null;

  // The paychecks still to come follow the regular ones: a bonus counts in
  // full toward the year to date, but its date and size say nothing about
  // when the next paycheck lands or what it will be (#113). With only
  // one-off stubs so far there's no pace, so nothing is projected.
  const regular = own.filter((s) => !s.oneTime);
  const cadence = cadenceDays(regular.length ? regular : own);
  const lastPayDate = (regular.length ? regular : own).at(-1)!.payDate;
  const remaining = regular.length ? remainingPaychecks(lastPayDate, cadence, year) : 0;
  const recent = regular.slice(-PACE_STUBS);

  // Year to date, and year to date plus the recent average for each
  // paycheck still to come.
  const total = (pick: (s: EstimateStub) => number) => own.reduce((sum, s) => sum + pick(s), 0);
  const pace = (pick: (s: EstimateStub) => number) => (recent.length ? Math.round(recent.reduce((sum, s) => sum + pick(s), 0) / recent.length) : 0);
  const figure = (pick: (s: EstimateStub) => number) => ({ ytdCents: total(pick), projectedCents: total(pick) + pace(pick) * remaining });
  const ofKinds = (kinds: PayLineKind[]) => (s: EstimateStub) => s.lines.filter((l) => kinds.includes(l.kind)).reduce((sum, l) => sum + l.amountCents, 0);
  const ofEmployer = (kinds: EmployerPayKind[]) => (s: EstimateStub) =>
    (s.employer ?? []).filter((l) => kinds.includes(l.kind)).reduce((sum, l) => sum + l.amountCents, 0);

  // Paid by the employer on top (#92). Imputed income isn't money paid but
  // the taxable value of life insurance over $50,000 of coverage: wages for
  // income tax, Social Security and Medicare, never paid in cash.
  const imputed = figure(ofEmployer(["imputed_income"]));
  const employerPresent = new Set(own.flatMap((s) => (s.employer ?? []).map((l) => l.kind)));
  const paid: EmployerPayKind[] = ["retirement_match", "hsa", "life_insurance", "other"];
  const employer = {
    lines: paid.filter((k) => employerPresent.has(k)).map((kind) => ({ kind, label: employerKindLabel(kind), ...figure(ofEmployer([kind])) })),
    total: figure(ofEmployer(paid)),
    imputed,
  };

  const gross = figure((s) => s.grossCents);
  const present = new Set(own.flatMap((s) => s.lines.map((l) => l.kind)));
  const taxes = TAX_KINDS.filter((k) => present.has(k)).map((kind) => ({ kind, label: kindLabel(kind), ...figure(ofKinds([kind])) }));
  const groups = (["insurance", "retirement", "other"] as PayLineGroup[])
    .map((group) => ({ group, ...figure(ofKinds([...present].filter((k) => groupOf(k) === group))) }))
    .filter((g) => g.ytdCents > 0);

  // Federal income tax for the whole year, if the year's tables are known.
  const table = FEDERAL[year];
  let federal = null;
  let fica = null;
  if (table) {
    const wages = gross.projectedCents + imputed.projectedCents - figure(ofKinds(PRE_INCOME_TAX)).projectedCents;
    const standard = table.standardDeduction[assumptions.filingStatus] * 100;
    const deductionCents = assumptions.itemizedDeductionsCents ?? standard;
    const taxableIncomeCents = Math.max(0, wages + assumptions.otherIncomeCents - deductionCents);
    const liabilityCents = Math.max(0, federalTax(year, assumptions.filingStatus, taxableIncomeCents)! - assumptions.creditsCents);
    const paidCents = (taxes.find((t) => t.kind === "federal_income_tax")?.projectedCents ?? 0) + assumptions.otherPaymentsCents;
    federal = {
      wagesCents: wages,
      deductionCents,
      itemized: assumptions.itemizedDeductionsCents !== null,
      taxableIncomeCents,
      liabilityCents,
      paidCents,
      // Positive: a refund. Negative: owed at filing.
      balanceCents: paidCents - liabilityCents,
    };

    // What Social Security and Medicare should come to on these wages: a
    // check on the payroll math, and the one place a refund can come from
    // (two jobs together withholding past the wage base).
    const ficaWages = gross.projectedCents + imputed.projectedCents - figure(ofKinds(PRE_FICA)).projectedCents;
    fica = {
      socialSecurity: {
        expectedCents: Math.round(Math.min(ficaWages, table.socialSecurityWageBase * 100) * SOCIAL_SECURITY_RATE),
        projectedCents: taxes.find((t) => t.kind === "social_security")?.projectedCents ?? 0,
      },
      medicare: {
        expectedCents: Math.round(ficaWages * MEDICARE_RATE),
        projectedCents: taxes.find((t) => t.kind === "medicare")?.projectedCents ?? 0,
      },
    };
  }

  // HSA contributions against the year's limit (#92): yours through payroll
  // and your employer's count together. No limit without coverage set, or
  // for a year with no published figures.
  const hsaLimits = HSA_LIMITS[year];
  const hsaYours = figure(ofKinds(["hsa"]));
  const hsaEmployer = figure(ofEmployer(["hsa"]));
  const hsa =
    hsaYours.ytdCents || hsaEmployer.ytdCents
      ? {
          yours: hsaYours,
          employer: hsaEmployer,
          projectedCents: hsaYours.projectedCents + hsaEmployer.projectedCents,
          limitCents: assumptions.hsaCoverage && hsaLimits ? (hsaLimits[assumptions.hsaCoverage] + (assumptions.hsaCatchUp ? HSA_CATCH_UP : 0)) * 100 : null,
        }
      : null;

  // Stubs that start well into the year leave earlier pay out of every
  // figure here; the page says so rather than understating the year.
  const firstPeriodStart = own[0].periodStart;
  const missingEarlierPay = firstPeriodStart > `${year}-01-31`;

  return {
    year,
    stubCount: own.length,
    oneTimeCount: own.length - regular.length,
    firstPeriodStart,
    missingEarlierPay,
    lastPayDate,
    cadenceDays: cadence,
    remainingPaychecks: remaining,
    gross,
    taxes,
    groups,
    federal,
    fica,
    employer,
    hsa,
  };
}
