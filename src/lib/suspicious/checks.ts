import { formatCents } from "@/lib/money";

// Suspicious-transaction checks (#33): rules, each explainable in one line,
// that flag a single charge that looks wrong. They run on each sync and on
// each Apple Pay purchase as it happens (src/operations/suspicious.ts), and
// the flags are alerts, so push, Home and Tally's digest see them like any
// other. No model: a local one may assist later, but a rule the owner can
// read is the point of a flag they have to act on.
//
// What's already covered elsewhere isn't repeated here: a subscription's
// price rise and a subscription billing twice are recurring alerts (#9,
// src/lib/recurring/detect.ts), and a charge either of those has flagged is
// skipped.
//
// Card-not-present isn't checked: no source the app has says how a card was
// used. SimpleFIN gives a description and an amount, and an Apple Pay
// purchase is card-present by definition. A foreign charge shows up only
// as the issuer's foreign transaction fee, so that's what is flagged.
//
// The owner's answers tune the next run, and every rule says how in its
// own comment:
//   - "Fine" on an unusual or first-time charge sets a ceiling for that
//     merchant: nothing up to a quarter above it is flagged as unusual again.
//   - "Fine" on a possible duplicate means repeat purchases there are
//     normal; that merchant isn't checked for duplicates again.
//   - Three first-time charges in a row marked fine raise the first-time bar
//     to their median; one marked suspicious puts it back.

export const LOOKBACK_DAYS = 365;

// Unusually large: at least this many times the usual amount, above
// anything charged there before, and this much above the usual in dollars,
// so a $4 coffee becoming $13 doesn't flag.
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_MIN_EXCESS_CENTS = 25_00;
// History needed before "usual" means anything. A merchant needs a few
// charges; a category, being broader, needs more.
export const MIN_MERCHANT_CHARGES = 3;
export const MIN_CATEGORY_CHARGES = 10;
// How far above an amount the owner called fine a later charge can go
// before it's unusual again.
export const FINE_HEADROOM = 1.25;

// A first-ever merchant is flagged at or above this, until tuned.
export const NEW_MERCHANT_MIN_CENTS = 200_00;
export const TUNE_AFTER = 3;

// Two charges this close, same account, merchant and amount. Below the
// minimum it's two coffees, not worth a question.
export const DUPLICATE_DAYS = 1;
export const DUPLICATE_MIN_CENTS = 10_00;

// The issuer's own fee line for a charge abroad or in another currency.
// Matched on the raw description, since a fee rarely has a merchant.
const FOREIGN_FEE = /\b(foreign|international|intl|fx|cross[- ]border)\b.{0,24}\b(fee|surcharge)\b/i;

export type FlagKind = "unusual_amount" | "new_merchant" | "possible_duplicate" | "foreign_fee";
export const FLAG_KINDS: FlagKind[] = ["unusual_amount", "new_merchant", "possible_duplicate", "foreign_fee"];
export const isFlagKind = (kind: string): kind is FlagKind => (FLAG_KINDS as string[]).includes(kind);

export type Charge = {
  id: string;
  accountId: string;
  merchant: string | null;
  description: string;
  date: string;
  // Money out, as a positive number.
  amountCents: number;
  categoryId: string | null;
  // A purchase alert's copy (#30): checked as it arrives, but never part of
  // anyone's history, since the bank's own copy will be.
  provisional: boolean;
  // Typed by the owner (#64): their own entry is never a duplicate to ask about.
  manual: boolean;
};

export type Verdict = { kind: FlagKind; merchant: string; amountCents: number | null; verdict: "fine" | "suspicious"; at: Date };

export type Context = {
  // Charges at each subject's merchant, and in each subject's category, from
  // LOOKBACK_DAYS before the earliest subject to a day after the latest.
  // Subjects themselves may be in here; each rule leaves them out.
  byMerchant: Map<string, Charge[]>;
  byCategory: Map<string, Charge[]>;
  // The two earliest synced charges ever at each subject's merchant: enough
  // to tell whether anything other than the subject came first.
  earliest: Map<string, { id: string; date: string }[]>;
  categoryName: (id: string) => string;
  accountName: (id: string) => string;
  verdicts: Verdict[];
};

export type FlagDraft = {
  kind: FlagKind;
  dedupeKey: string;
  merchant: string;
  accountId: string;
  transactionId: string;
  occurredOn: string;
  amountCents: number;
  title: string;
  detail: string;
};

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Per merchant, the most the owner has called fine there, if anything. */
function fineCeilings(verdicts: Verdict[]): Map<string, number> {
  const ceilings = new Map<string, number>();
  for (const v of verdicts) {
    if (v.verdict !== "fine" || v.amountCents === null || (v.kind !== "unusual_amount" && v.kind !== "new_merchant")) continue;
    ceilings.set(v.merchant, Math.max(ceilings.get(v.merchant) ?? 0, v.amountCents));
  }
  return ceilings;
}

/**
 * The bar for a first-time merchant. The owner's answers since the last
 * "suspicious": once TUNE_AFTER of them are "fine", the bar is their
 * median, so it follows what the owner actually spends at new places, and
 * one real problem puts it back to the default.
 */
export function newMerchantBar(verdicts: Verdict[]): number {
  const answers = verdicts.filter((v) => v.kind === "new_merchant").sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastSuspicious = answers.findLastIndex((v) => v.verdict === "suspicious");
  const fine = answers
    .slice(lastSuspicious + 1)
    .map((v) => v.amountCents)
    .filter((a): a is number => a !== null);
  return fine.length >= TUNE_AFTER ? Math.max(NEW_MERCHANT_MIN_CENTS, median(fine)) : NEW_MERCHANT_MIN_CENTS;
}

const where = (ctx: Context, accountId: string) => {
  const name = ctx.accountName(accountId);
  return name ? ` on ${name}` : "";
};

/** Earlier synced charges, within the lookback, from a list. */
const before = (list: Charge[], c: Charge) =>
  list.filter((h) => h.id !== c.id && !h.provisional && h.date < c.date && h.date >= shift(c.date, -LOOKBACK_DAYS));

function duplicate(c: Charge, ctx: Context, repeatsFine: Set<string>): FlagDraft | null {
  if (!c.merchant || c.provisional || c.manual || c.amountCents < DUPLICATE_MIN_CENTS || repeatsFine.has(c.merchant)) return null;
  // The later of the two is the one flagged, so a pair raises one flag. On
  // the same day, the id breaks the tie: arbitrary, but the same every run.
  const first = (ctx.byMerchant.get(c.merchant) ?? []).find(
    (d) =>
      d.id !== c.id &&
      !d.provisional &&
      !d.manual &&
      d.accountId === c.accountId &&
      d.amountCents === c.amountCents &&
      daysBetween(d.date, c.date) <= DUPLICATE_DAYS &&
      (d.date < c.date || (d.date === c.date && d.id < c.id)),
  );
  if (!first) return null;
  const amount = formatCents(c.amountCents);
  return {
    ...base(c, "possible_duplicate"),
    title: `${c.merchant} charged ${amount} twice`,
    detail: `${amount} on ${first.date} and again on ${c.date}${where(ctx, c.accountId)}. Fine if you bought twice; otherwise ask ${c.merchant} or the card issuer.`,
  };
}

function unusual(c: Charge, ctx: Context, ceilings: Map<string, number>): FlagDraft | null {
  if (!c.merchant) return null;
  const ceiling = ceilings.get(c.merchant);
  if (ceiling !== undefined && c.amountCents <= ceiling * FINE_HEADROOM) return null;

  // The merchant's own history first; a category stands in only for a
  // merchant too new to have a usual.
  const atMerchant = before(ctx.byMerchant.get(c.merchant) ?? [], c);
  const inCategory = c.categoryId ? before(ctx.byCategory.get(c.categoryId) ?? [], c) : [];
  const basis =
    atMerchant.length >= MIN_MERCHANT_CHARGES
      ? { charges: atMerchant, label: `at ${c.merchant}` }
      : inCategory.length >= MIN_CATEGORY_CHARGES && c.categoryId
        ? { charges: inCategory, label: `for ${ctx.categoryName(c.categoryId)}` }
        : null;
  if (!basis) return null;

  const amounts = basis.charges.map((h) => h.amountCents);
  const usual = median(amounts);
  const most = Math.max(...amounts);
  if (c.amountCents < usual * UNUSUAL_MULTIPLE || c.amountCents <= most || c.amountCents - usual < UNUSUAL_MIN_EXCESS_CENTS) return null;
  return {
    ...base(c, "unusual_amount"),
    title: `${formatCents(c.amountCents)} at ${c.merchant}, about ${Math.round(c.amountCents / usual)}× usual`,
    detail:
      `Usually about ${formatCents(usual)} ${basis.label} (the most before was ${formatCents(most)}, ` +
      `across ${amounts.length} charges in the past year). Charged on ${c.date}${where(ctx, c.accountId)}.`,
  };
}

function firstTime(c: Charge, ctx: Context, bar: number): FlagDraft | null {
  if (!c.merchant || c.amountCents < bar) return null;
  const seenBefore = (ctx.earliest.get(c.merchant) ?? []).some((e) => e.id !== c.id && e.date < c.date);
  if (seenBefore) return null;
  return {
    ...base(c, "new_merchant"),
    title: `First charge from ${c.merchant}: ${formatCents(c.amountCents)}`,
    detail: `Nothing from ${c.merchant} before, and it's ${formatCents(bar)} or more. Charged on ${c.date}${where(ctx, c.accountId)}. Fine if you know it.`,
  };
}

function foreignFee(c: Charge, ctx: Context): FlagDraft | null {
  if (!FOREIGN_FEE.test(c.description)) return null;
  return {
    ...base(c, "foreign_fee"),
    merchant: c.merchant ?? c.description,
    title: `Foreign transaction fee: ${formatCents(c.amountCents)}`,
    detail: `Charged on ${c.date}${where(ctx, c.accountId)}, for a purchase abroad or in another currency. Fine if you were travelling or bought from abroad.`,
  };
}

function base(c: Charge, kind: FlagKind) {
  return {
    kind,
    dedupeKey: `${kind}|${c.id}`,
    merchant: c.merchant ?? c.description,
    accountId: c.accountId,
    transactionId: c.id,
    occurredOn: c.date,
    amountCents: c.amountCents,
  };
}

/**
 * At most one flag per charge, the most pointed first: a foreign fee is
 * exactly what it says, a duplicate says more than "large", and "large for
 * this merchant" more than "new".
 */
export function flagsFor(subjects: Charge[], ctx: Context): FlagDraft[] {
  const ceilings = fineCeilings(ctx.verdicts);
  const bar = newMerchantBar(ctx.verdicts);
  const repeatsFine = new Set(ctx.verdicts.filter((v) => v.kind === "possible_duplicate" && v.verdict === "fine").map((v) => v.merchant));
  const drafts: FlagDraft[] = [];
  for (const c of subjects) {
    const flag = foreignFee(c, ctx) ?? duplicate(c, ctx, repeatsFine) ?? unusual(c, ctx, ceilings) ?? firstTime(c, ctx, bar);
    if (flag) drafts.push(flag);
  }
  return drafts;
}
