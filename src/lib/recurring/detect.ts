// Recurring charges and subscription alerts (#9): pure, rule-based, no
// model. Detection runs over recent spending each time it's read; the
// owner's confirm/dismiss decisions are the only stored state.
//
// A series is one merchant in one account. It's recurring when its charges
// land on a steady cadence (weekly … annual) within a tolerance. A
// same-amount charge a few days after another is the same occurrence (a
// retry, or a duplicate — which is its own alert). The amount may drift: a fixed-price series stays within 25% of
// its median; anything wider is flagged variable (a utility bill), which
// still recurs but gets no price-increase alerts.

export type Charge = { id: string; accountId: string; merchant: string; date: string; amountCents: number }; // amountCents > 0 = spent

export const CADENCES = [
  { name: "weekly", days: 7, tolerance: 2, perYear: 52 },
  { name: "every 2 weeks", days: 14, tolerance: 3, perYear: 26 },
  { name: "monthly", days: 30.44, tolerance: 5, perYear: 12 },
  { name: "quarterly", days: 91.3, tolerance: 10, perYear: 4 },
  { name: "twice a year", days: 182.6, tolerance: 15, perYear: 2 },
  { name: "annual", days: 365.25, tolerance: 20, perYear: 1 },
] as const;
export type Cadence = (typeof CADENCES)[number];

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const addDays = (date: string, days: number) => new Date(Date.parse(date) + Math.round(days) * DAY_MS).toISOString().slice(0, 10);

// Charges this close are the same occurrence (or a duplicate of it).
const SAME_OCCURRENCE_DAYS = 3;
const VARIABLE_SPREAD = 0.25;
// Alerts are about now: a price rise from last year isn't news. Matches the
// first sync's 90-day backfill, so a new connection's recent events count.
const RECENT_DAYS = 90;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export type Occurrence = { date: string; amountCents: number; chargeIds: string[]; duplicates: Charge[] };

export type Series = {
  key: string; // `${merchant}|${accountId}`
  merchant: string;
  accountId: string;
  cadence: Cadence;
  occurrences: Occurrence[];
  // The usual amount: median of the last three occurrences.
  typicalCents: number;
  latestCents: number;
  variable: boolean;
  firstOn: string;
  lastOn: string;
  nextExpectedOn: string;
  annualizedCents: number;
  // Charged within its cadence (plus tolerance) of today.
  active: boolean;
};

export const seriesKey = (merchant: string, accountId: string) => `${merchant}|${accountId}`;

/** Groups close-together charges into occurrences, keeping the extras as possible duplicates. */
function occurrencesOf(charges: Charge[]): Occurrence[] {
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const result: Occurrence[] = [];
  for (const charge of sorted) {
    const last = result.at(-1);
    // Only a same-amount charge days later is the same occurrence (a retry
    // or a duplicate). Merging any nearby charges would turn frequent,
    // irregular shopping into a tidy weekly rhythm.
    const sameAmount = last && Math.abs(last.amountCents - charge.amountCents) <= Math.max(1, last.amountCents * 0.01);
    if (last && sameAmount && daysBetween(last.date, charge.date) <= SAME_OCCURRENCE_DAYS) {
      last.duplicates.push(charge);
      last.chargeIds.push(charge.id);
    } else {
      result.push({ date: charge.date, amountCents: charge.amountCents, chargeIds: [charge.id], duplicates: [] });
    }
  }
  return result;
}

function cadenceOf(occurrences: Occurrence[]): Cadence | null {
  const intervals = occurrences.slice(1).map((o, i) => daysBetween(occurrences[i].date, o.date));
  if (intervals.length === 0) return null;
  const typical = median(intervals);
  const cadence = CADENCES.find((c) => Math.abs(typical - c.days) <= c.tolerance);
  if (!cadence) return null;
  // Annual needs two charges; anything more frequent needs three, or a
  // coincidence of two looks like a subscription.
  if (cadence.name !== "annual" && cadence.name !== "twice a year" && occurrences.length < 3) return null;
  // Most intervals must fit, not just the median (twice the tolerance
  // forgives one late posting).
  const fitting = intervals.filter((d) => Math.abs(d - cadence.days) <= cadence.tolerance * 2).length;
  return fitting / intervals.length >= 2 / 3 ? cadence : null;
}

function nextAfter(date: string, cadence: Cadence): string {
  if (cadence.name === "monthly" || cadence.name === "quarterly" || cadence.name === "twice a year" || cadence.name === "annual") {
    // Calendar months, keeping the day (clamped to the month's end).
    const months = { monthly: 1, quarterly: 3, "twice a year": 6, annual: 12 }[cadence.name];
    const d = new Date(`${date}T00:00:00Z`);
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
    return target.toISOString().slice(0, 10);
  }
  return addDays(date, cadence.days);
}

export function detectSeries(charges: Charge[], today: string): Series[] {
  const groups = new Map<string, Charge[]>();
  for (const c of charges) {
    if (c.amountCents <= 0 || !c.merchant) continue;
    const key = seriesKey(c.merchant, c.accountId);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const series: Series[] = [];
  for (const [key, group] of groups) {
    const occurrences = occurrencesOf(group);
    const cadence = cadenceOf(occurrences);
    if (!cadence) continue;
    const amounts = occurrences.map((o) => o.amountCents);
    const typicalCents = median(amounts.slice(-3));
    // Spread over real charges: a token trial charge ($1 before $12.99)
    // doesn't make a fixed-price plan "variable".
    const recent = amounts.slice(-6).filter((a) => a >= typicalCents * 0.5);
    const mid = median(recent);
    const variable = mid > 0 && (Math.max(...recent) - Math.min(...recent)) / mid > VARIABLE_SPREAD;
    const last = occurrences.at(-1)!;
    series.push({
      key,
      merchant: group[0].merchant,
      accountId: group[0].accountId,
      cadence,
      occurrences,
      typicalCents,
      latestCents: last.amountCents,
      variable,
      firstOn: occurrences[0].date,
      lastOn: last.date,
      nextExpectedOn: nextAfter(last.date, cadence),
      annualizedCents: typicalCents * cadence.perYear,
      active: daysBetween(last.date, today) <= cadence.days + cadence.tolerance * 2,
    });
  }
  return series.sort((a, b) => b.annualizedCents - a.annualizedCents);
}

// --- Alerts ---------------------------------------------------------------------

export type AlertDraft = {
  kind: "price_increase" | "duplicate_charge" | "overlapping_subscriptions" | "trial_converted" | "missing_charge" | "charged_after_cancel";
  dedupeKey: string;
  merchant: string;
  accountId: string | null;
  transactionId: string | null;
  occurredOn: string;
  // Amounts for the message; formatted by the caller.
  fromCents?: number;
  toCents?: number;
  cadence?: string;
  cancelledOn?: string;
};

export type SeriesStatus = "confirmed" | "dismissed" | "cancelled";

/**
 * Alerts for detected series, given the owner's decisions. Dismissed and
 * cancelled series raise nothing here (a cancelled one has its own check,
 * chargesAfterCancel). Missing-charge alerts need a confirmed series — a
 * merely detected one may simply have ended. Each alert carries a
 * dedupeKey naming the event, so it's raised once.
 */
export function alertsFor(series: Series[], status: Map<string, SeriesStatus>, today: string): AlertDraft[] {
  const drafts: AlertDraft[] = [];
  const recent = (date: string) => daysBetween(date, today) <= RECENT_DAYS;
  const live = series.filter((s) => status.get(s.key) !== "dismissed" && status.get(s.key) !== "cancelled");

  for (const s of live) {
    const occ = s.occurrences;

    // Price increase: a fixed-price series charging more than the time
    // before. Any recent step up, not only the latest charge, so a rise is
    // still caught after a missed night or a first sync.
    if (!s.variable) {
      occ.forEach((o, i) => {
        const before = occ[i - 1];
        // A step up from a token trial charge is the trial alert's job.
        if (!before || !recent(o.date) || before.amountCents < s.typicalCents * 0.5) return;
        if (o.amountCents > before.amountCents * 1.01 && o.amountCents - before.amountCents >= 50) {
          drafts.push({
            kind: "price_increase",
            dedupeKey: `price_increase|${s.key}|${o.date}`,
            merchant: s.merchant,
            accountId: s.accountId,
            transactionId: o.chargeIds[0],
            occurredOn: o.date,
            fromCents: before.amountCents,
            toCents: o.amountCents,
          });
        }
      });
    }

    // Duplicate: a second charge of the same amount within days, in a
    // series that normally charges once per period.
    for (const o of occ.filter((o) => recent(o.date))) {
      for (const dup of o.duplicates) {
        if (Math.abs(dup.amountCents - o.amountCents) <= Math.max(1, o.amountCents * 0.01) && s.cadence.days >= 14) {
          drafts.push({
            kind: "duplicate_charge",
            dedupeKey: `duplicate_charge|${dup.id}`,
            merchant: s.merchant,
            accountId: s.accountId,
            transactionId: dup.id,
            occurredOn: dup.date,
            toCents: dup.amountCents,
          });
        }
      }
    }

    // Free trial converting: a token charge (≤ 20% of the usual price)
    // followed within 40 days by the first full-price one, recently.
    const firstFull = occ.findIndex((o) => o.amountCents >= s.typicalCents * 0.5);
    if (firstFull > 0 && recent(occ[firstFull].date)) {
      const trial = occ.slice(0, firstFull).filter((o) => o.amountCents <= s.typicalCents * 0.2 && daysBetween(o.date, occ[firstFull].date) <= 40);
      if (trial.length) {
        drafts.push({
          kind: "trial_converted",
          dedupeKey: `trial_converted|${s.key}|${occ[firstFull].date}`,
          merchant: s.merchant,
          accountId: s.accountId,
          transactionId: occ[firstFull].chargeIds[0],
          occurredOn: occ[firstFull].date,
          fromCents: trial.at(-1)!.amountCents,
          toCents: occ[firstFull].amountCents,
          cadence: s.cadence.name,
        });
      }
    }

    // Missing: a confirmed series past its due date plus tolerance.
    const due = s.nextExpectedOn;
    if (status.get(s.key) === "confirmed" && daysBetween(due, today) > s.cadence.tolerance && recent(due)) {
      drafts.push({
        kind: "missing_charge",
        dedupeKey: `missing_charge|${s.key}|${due}`,
        merchant: s.merchant,
        accountId: s.accountId,
        transactionId: null,
        occurredOn: due,
        toCents: s.typicalCents,
        cadence: s.cadence.name,
      });
    }
  }

  // Overlapping: the same merchant billing in two accounts at once.
  const active = live.filter((s) => s.active);
  const byMerchant = new Map<string, Series[]>();
  for (const s of active) byMerchant.set(s.merchant, [...(byMerchant.get(s.merchant) ?? []), s]);
  for (const [merchant, list] of byMerchant) {
    if (list.length < 2) continue;
    const accounts = list.map((s) => s.accountId).sort();
    drafts.push({
      kind: "overlapping_subscriptions",
      dedupeKey: `overlapping_subscriptions|${merchant}|${accounts.join(",")}`,
      merchant,
      accountId: null,
      transactionId: null,
      occurredOn: list.map((s) => s.lastOn).sort().at(-1)!,
      toCents: list.reduce((sum, s) => sum + s.annualizedCents, 0),
    });
  }
  return drafts;
}

// --- Cancelled (#82) ------------------------------------------------------------

export type Cancellation = { merchant: string; accountId: string; cancelledOn: string; graceDays: number };

/**
 * Days after cancelling during which a charge is still expected, not an
 * alert. A fixed-price subscription doesn't prorate, so this only covers a
 * charge made just before cancelling that posts a few days later; a
 * variable bill (power, phone) sends a final bill for the last partial
 * period, which arrives with the next statement.
 */
export const cancelGraceDays = (series: Pick<Series, "variable">) => (series.variable ? 35 : 7);

/**
 * One alert per charge from a cancelled series that posts after the cancel
 * date plus its grace window. Read from the raw charges, not detection: a
 * single stray charge after months of quiet no longer looks like a series.
 */
export function chargesAfterCancel(charges: Charge[], cancelled: Cancellation[]): AlertDraft[] {
  const byKey = new Map(cancelled.map((c) => [seriesKey(c.merchant, c.accountId), c]));
  return charges.flatMap((charge): AlertDraft[] => {
    const c = byKey.get(seriesKey(charge.merchant, charge.accountId));
    if (!c || charge.amountCents <= 0 || charge.date <= addDays(c.cancelledOn, c.graceDays)) return [];
    return [
      {
        kind: "charged_after_cancel",
        dedupeKey: `charged_after_cancel|${charge.id}`,
        merchant: charge.merchant,
        accountId: charge.accountId,
        transactionId: charge.id,
        occurredOn: charge.date,
        toCents: charge.amountCents,
        cancelledOn: c.cancelledOn,
      },
    ];
  });
}
