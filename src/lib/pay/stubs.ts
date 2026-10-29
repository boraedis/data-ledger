import type { employerPayKind, payLineKind } from "@/db/schema";

// Pay stubs (#60), the parts with no database: what each deduction kind
// is, the check that a stub adds up, and which deposit is its net pay.

export type PayLineKind = (typeof payLineKind.enumValues)[number];
export type PayLineGroup = "tax" | "insurance" | "retirement" | "other";

export const PAY_LINE_KINDS: { kind: PayLineKind; label: string; group: PayLineGroup }[] = [
  { kind: "federal_income_tax", label: "Federal income tax", group: "tax" },
  { kind: "state_income_tax", label: "State income tax", group: "tax" },
  { kind: "local_income_tax", label: "Local income tax", group: "tax" },
  { kind: "social_security", label: "Social Security", group: "tax" },
  { kind: "medicare", label: "Medicare", group: "tax" },
  { kind: "state_disability", label: "State disability (SDI)", group: "tax" },
  { kind: "health_insurance", label: "Health insurance", group: "insurance" },
  { kind: "dental_insurance", label: "Dental insurance", group: "insurance" },
  { kind: "vision_insurance", label: "Vision insurance", group: "insurance" },
  { kind: "retirement_pretax", label: "Retirement (pre-tax, e.g. 401(k))", group: "retirement" },
  { kind: "retirement_roth", label: "Retirement (Roth)", group: "retirement" },
  { kind: "hsa", label: "HSA", group: "retirement" },
  { kind: "fsa", label: "FSA", group: "other" },
  { kind: "other", label: "Other", group: "other" },
];

export const GROUP_LABELS: Record<PayLineGroup, string> = {
  tax: "Taxes",
  insurance: "Insurance",
  retirement: "Retirement & savings",
  other: "Other deductions",
};

// What the employer pays on top (#92), from the stub's memo box. None of
// it is in gross or net.
export type EmployerPayKind = (typeof employerPayKind.enumValues)[number];
export const EMPLOYER_PAY_KINDS: { kind: EmployerPayKind; label: string; hint: string }[] = [
  { kind: "retirement_match", label: "401(k) match", hint: "What the employer put into your 401(k)" },
  { kind: "hsa", label: "HSA contribution", hint: "Counts toward your HSA limit with your own" },
  { kind: "life_insurance", label: "Life insurance (employer cost)", hint: "What the employer paid; shown only" },
  { kind: "imputed_income", label: "Imputed income (taxable, not paid)", hint: "Life insurance over $50,000 of coverage: taxed as wages" },
  { kind: "other", label: "Other employer-paid", hint: "Shown only" },
];
const employerByKind = new Map(EMPLOYER_PAY_KINDS.map((k) => [k.kind, k]));
export const employerKindLabel = (kind: EmployerPayKind): string => employerByKind.get(kind)?.label ?? kind;

const byKind = new Map(PAY_LINE_KINDS.map((k) => [k.kind, k]));
export const groupOf = (kind: PayLineKind): PayLineGroup => byKind.get(kind)?.group ?? "other";
export const kindLabel = (kind: PayLineKind): string => byKind.get(kind)?.label ?? kind;

/** Null when gross less the lines is exactly the net; otherwise what's off, for the owner to fix. */
export function stubMismatch(grossCents: number, lines: { amountCents: number }[], netCents: number): string | null {
  const withheld = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const expected = grossCents - withheld;
  if (expected === netCents) return null;
  const cents = (n: number) => `$${(n / 100).toFixed(2)}`;
  return `Gross ${cents(grossCents)} less ${cents(withheld)} withheld is ${cents(expected)}, not the net ${cents(netCents)} (off by ${cents(Math.abs(expected - netCents))})`;
}

// How far a deposit's date can be from the pay date: banks post payroll a
// day or two early or late around weekends and holidays.
export const DEPOSIT_DAYS_BEFORE = 3;
export const DEPOSIT_DAYS_AFTER = 5;

const DAY_MS = 86_400_000;
const offset = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

export type DepositCandidate = { id: string; postedOn: string; amountCents: number; accountId: string; merchant: string | null };

// Pay split across accounts (#91) is two deposits, three at most (savings,
// checking, one more), each in its own account.
const MAX_SPLIT = 3;

/**
 * The ways deposits could make up this stub's net pay, best first: a single
 * deposit of exactly the net, then pay split across accounts. A split is
 * two or three money-in deposits near the pay date, each in a different
 * account, all from the same payer (the same merchant name: payroll
 * deposits share the employer's descriptor), adding up to the net exactly.
 * Within each size, closest to the pay date first. Each match lists its
 * largest deposit first.
 *
 * `anyPayer` drops the same-payer rule, for the owner to choose from when a
 * bank names the two halves of a paycheck differently. Never for linking
 * automatically: two unrelated deposits can add up to a net by chance.
 */
export function depositMatches(
  stub: { payDate: string; netCents: number },
  deposits: DepositCandidate[],
  { anyPayer = false }: { anyPayer?: boolean } = {},
): DepositCandidate[][] {
  const near = deposits
    .map((d) => ({ d, off: offset(stub.payDate, d.postedOn) }))
    .filter(({ d, off }) => d.amountCents > 0 && d.amountCents <= stub.netCents && off >= -DEPOSIT_DAYS_BEFORE && off <= DEPOSIT_DAYS_AFTER);
  const distance = (set: typeof near) => set.reduce((sum, x) => sum + Math.abs(x.off), 0);

  const matches: (typeof near)[] = near.filter((x) => x.d.amountCents === stub.netCents).map((x) => [x]);
  const parts = near.filter((x) => x.d.amountCents < stub.netCents && (anyPayer || x.d.merchant));
  const grow = (set: typeof near, from: number, sum: number) => {
    if (set.length >= 2 && sum === stub.netCents) matches.push(set);
    if (set.length === MAX_SPLIT || sum >= stub.netCents) return;
    for (let i = from; i < parts.length; i++) {
      const next = parts[i];
      if (set.length && ((!anyPayer && next.d.merchant !== set[0].d.merchant) || set.some((x) => x.d.accountId === next.d.accountId))) continue;
      grow([...set, next], i + 1, sum + next.d.amountCents);
    }
  };
  grow([], 0, 0);

  return matches
    .sort((a, b) => a.length - b.length || distance(a) - distance(b) || a[0].d.postedOn.localeCompare(b[0].d.postedOn))
    .map((set) => set.map((x) => x.d).sort((a, b) => b.amountCents - a.amountCents || a.id.localeCompare(b.id)));
}

/**
 * What a linked deposit counts as in budgets: gross pay in the deposit's
 * own category, and each deduction that has a category as its own line,
 * negative (money that left the gross before it reached the bank). A
 * deduction without a category is netted against gross instead. Either
 * way the parts add up to the deposit exactly, so nothing is counted
 * twice and nothing goes missing.
 */
export function expandDeposit(
  deposit: { categoryId: string; amountCents: number },
  stub: { grossCents: number; lines: { amountCents: number; categoryId: string | null }[] },
): { categoryId: string; amountCents: number }[] {
  const placed = stub.lines.filter((l): l is { amountCents: number; categoryId: string } => l.categoryId !== null);
  const unplaced = stub.lines.filter((l) => l.categoryId === null).reduce((sum, l) => sum + l.amountCents, 0);
  const parts = [
    { categoryId: deposit.categoryId, amountCents: stub.grossCents - unplaced },
    ...placed.map((l) => ({ categoryId: l.categoryId, amountCents: -l.amountCents })),
  ];
  // A stub that no longer matches its deposit (edited since) counts as
  // the deposit alone rather than as numbers that don't add up.
  const total = parts.reduce((sum, p) => sum + p.amountCents, 0);
  return total === deposit.amountCents ? parts.filter((p) => p.amountCents !== 0) : [deposit];
}

/**
 * A new stub's starting point: the last one moved on by one pay period
 * (its own length), with the same deductions and amounts. Most paychecks
 * repeat, so usually only what changed needs typing.
 */
export function nextPeriod(last: { periodStart: string; periodEnd: string; payDate: string }) {
  const length = Math.round((Date.parse(last.periodEnd) - Date.parse(last.periodStart)) / DAY_MS) + 1;
  const move = (on: string) => new Date(Date.parse(on) + length * DAY_MS).toISOString().slice(0, 10);
  return { periodStart: move(last.periodStart), periodEnd: move(last.periodEnd), payDate: move(last.payDate) };
}
