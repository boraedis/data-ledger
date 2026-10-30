import { describe, expect, it } from "vitest";
import { alertsFor, cancelGraceDays, chargesAfterCancel, detectSeries, seriesKey, type Charge } from "@/lib/recurring/detect";

// Invented merchants and amounts. amountCents > 0 = spent.

let n = 0;
const c = (merchant: string, date: string, dollars: number, accountId = "card"): Charge => ({
  id: `t${++n}`,
  accountId,
  merchant,
  date,
  amountCents: Math.round(dollars * 100),
});
const monthly = (merchant: string, days: string[], dollars: number | number[], accountId = "card") =>
  days.map((d, i) => c(merchant, d, Array.isArray(dollars) ? dollars[i] : dollars, accountId));

const MONTHS = ["2026-01-03", "2026-02-03", "2026-03-04", "2026-04-03", "2026-05-03", "2026-06-02"];
const TODAY = "2026-06-20";

describe("detectSeries", () => {
  it("finds a monthly subscription with its next charge and yearly cost", () => {
    const [s] = detectSeries(monthly("Tunebox", MONTHS, 10.99), TODAY);
    expect(s).toMatchObject({ merchant: "Tunebox", typicalCents: 1_099, nextExpectedOn: "2026-07-02", annualizedCents: 13_188, active: true, variable: false });
    expect(s.cadence.name).toBe("monthly");
  });

  it("recognizes weekly and annual cadences, and needs three charges for anything but annual", () => {
    const weekly = detectSeries(monthly("Laundry Club", ["2026-06-01", "2026-06-08", "2026-06-15"], 12), TODAY);
    expect(weekly[0].cadence.name).toBe("weekly");
    expect(detectSeries(monthly("Cloudbox", ["2025-03-10", "2026-03-12"], 99), TODAY)[0].cadence.name).toBe("annual");
    expect(detectSeries(monthly("Once Twice", ["2026-05-01", "2026-06-01"], 20), TODAY)).toEqual([]);
  });

  it("ignores irregular spending, and marks wide-ranging bills variable", () => {
    const coffee = ["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05", "2026-06-09", "2026-06-10", "2026-06-15"].map((d) => c("Corner Bean", d, 5));
    expect(detectSeries(coffee, TODAY)).toEqual([]);
    const [power] = detectSeries(monthly("City Power", MONTHS, [65, 140, 98, 72, 120, 80]), TODAY);
    expect(power.variable).toBe(true);
  });

  it("keeps the same merchant in two accounts as separate series, and goes inactive when charges stop", () => {
    const series = detectSeries([...monthly("Tunebox", MONTHS, 10.99), ...monthly("Tunebox", MONTHS, 10.99, "checking")], TODAY);
    expect(series.map((s) => s.accountId).sort()).toEqual(["card", "checking"]);
    expect(detectSeries(monthly("Tunebox", MONTHS.slice(0, 3), 10.99), TODAY)[0].active).toBe(false);
  });
});

describe("alertsFor", () => {
  const none = new Map<string, "confirmed" | "dismissed">();
  const kinds = (charges: Charge[], status = none) => alertsFor(detectSeries(charges, TODAY), status, TODAY).map((a) => a.kind);

  it("flags a price increase on a fixed-price series, not on a variable bill", () => {
    const [alert] = alertsFor(detectSeries(monthly("Streamflix", MONTHS, [15.49, 15.49, 15.49, 15.49, 15.49, 17.99]), TODAY), none, TODAY);
    expect(alert).toMatchObject({ kind: "price_increase", fromCents: 1_549, toCents: 1_799, occurredOn: "2026-06-02" });
    expect(kinds(monthly("City Power", MONTHS, [65, 140, 98, 72, 120, 160]))).toEqual([]);
    // A rise a couple of months back is still caught; one long ago isn't news.
    expect(kinds(monthly("Streamflix", MONTHS, [15.49, 15.49, 15.49, 15.49, 17.99, 17.99]))).toEqual(["price_increase"]);
    expect(kinds(monthly("Streamflix", MONTHS, [15.49, 17.99, 17.99, 17.99, 17.99, 17.99]))).toEqual([]);
  });

  it("flags a duplicate charge within days", () => {
    const [alert] = alertsFor(detectSeries([...monthly("Ironworks Gym", MONTHS, 45), c("Ironworks Gym", "2026-06-04", 45)], TODAY), none, TODAY);
    expect(alert).toMatchObject({ kind: "duplicate_charge", occurredOn: "2026-06-04", toCents: 4_500 });
  });

  it("flags a free trial turning into a paid subscription", () => {
    const charges = monthly("Videopal", ["2026-04-01", "2026-05-01", "2026-06-01"], [1, 12.99, 12.99]);
    const [alert] = alertsFor(detectSeries(charges, TODAY), none, TODAY);
    expect(alert).toMatchObject({ kind: "trial_converted", fromCents: 100, toCents: 1_299, occurredOn: "2026-05-01" });
    expect(detectSeries(charges, TODAY)[0].variable).toBe(false);
  });

  it("flags the same subscription billed in two accounts", () => {
    expect(kinds([...monthly("Tunebox", MONTHS, 10.99), ...monthly("Tunebox", MONTHS, 10.99, "checking")])).toEqual(["overlapping_subscriptions"]);
  });

  it("flags a missing charge only for a confirmed series", () => {
    const charges = monthly("Tunebox", ["2026-02-03", "2026-03-03", "2026-04-03", "2026-05-03"], 10.99);
    expect(kinds(charges)).toEqual([]);
    const confirmed = new Map([[seriesKey("Tunebox", "card"), "confirmed" as const]]);
    const [alert] = alertsFor(detectSeries(charges, TODAY), confirmed, TODAY);
    expect(alert).toMatchObject({ kind: "missing_charge", occurredOn: "2026-06-03" });
  });

  it("raises one ended alert however many cycles are missed (#83)", () => {
    const charges = monthly("Ironworks Gym", ["2026-01-03", "2026-02-03", "2026-03-03", "2026-04-03"], 45);
    const confirmed = new Map([[seriesKey("Ironworks Gym", "card"), "confirmed" as const]]);
    // Three missed cycles (May, Jun, Jul), checked nightly.
    const keys = new Set(
      ["2026-05-12", "2026-06-12", "2026-07-12", "2026-07-30"].flatMap((on) => alertsFor(detectSeries(charges, on), confirmed, on).map((a) => a.dedupeKey)),
    );
    expect([...keys]).toEqual([`missing_charge|${seriesKey("Ironworks Gym", "card")}|2026-05-03`]);
    const [alert] = alertsFor(detectSeries(charges, "2026-05-12"), confirmed, "2026-05-12");
    expect(alert).toMatchObject({ fromCents: 4_500, lastOn: "2026-04-03" });
  });

  it("stays quiet about a gap the owner called still active, until a new charge and a new gap", () => {
    const key = seriesKey("Ironworks Gym", "card");
    const confirmed = new Map([[key, "confirmed" as const]]);
    const acked = new Map([[key, "2026-04-03"]]);
    const before = monthly("Ironworks Gym", ["2026-01-03", "2026-02-03", "2026-03-03", "2026-04-03"], 45);
    expect(alertsFor(detectSeries(before, "2026-06-12"), confirmed, "2026-06-12", acked)).toEqual([]);
    // It charged again in June, then went quiet: that's a new gap.
    const after = [...before, ...monthly("Ironworks Gym", ["2026-06-03"], 45)];
    expect(alertsFor(detectSeries(after, "2026-07-20"), confirmed, "2026-07-20", acked).map((a) => a.occurredOn)).toEqual(["2026-07-03"]);
  });

  it("raises nothing for a dismissed series", () => {
    const dismissed = new Map([[seriesKey("Streamflix", "card"), "dismissed" as const]]);
    expect(kinds(monthly("Streamflix", MONTHS, [15.49, 15.49, 15.49, 15.49, 15.49, 17.99]), dismissed)).toEqual([]);
  });
});

describe("cancelled subscriptions (#82)", () => {
  const cancelled = { merchant: "Streamflix", accountId: "card", cancelledOn: "2026-06-10", graceDays: 7 };

  it("alerts once per charge after the cancel date and grace window", () => {
    const charges = [
      c("Streamflix", "2026-06-02", 17.99), // before cancelling
      c("Streamflix", "2026-06-14", 17.99), // inside the grace window: a charge that posted late
      c("Streamflix", "2026-07-02", 17.99),
      c("Streamflix", "2026-08-02", 17.99),
      c("Streamflix", "2026-07-02", 17.99, "checking"), // another account: not this series
      c("Tunebox", "2026-07-07", 10.99),
    ];
    const drafts = chargesAfterCancel(charges, [cancelled]);
    expect(drafts.map((d) => [d.occurredOn, d.dedupeKey])).toEqual([
      ["2026-07-02", `charged_after_cancel|${charges[2].id}`],
      ["2026-08-02", `charged_after_cancel|${charges[3].id}`],
    ]);
    expect(drafts[0]).toMatchObject({ kind: "charged_after_cancel", merchant: "Streamflix", toCents: 1_799, cancelledOn: "2026-06-10", transactionId: charges[2].id });
  });

  it("gives a variable bill a longer window for its final bill", () => {
    expect(cancelGraceDays({ variable: false })).toBe(7);
    expect(cancelGraceDays({ variable: true })).toBe(35);
    const power = { merchant: "City Power", accountId: "checking", cancelledOn: "2026-06-10", graceDays: 35 };
    expect(chargesAfterCancel([c("City Power", "2026-07-12", 48.2, "checking")], [power])).toEqual([]);
    expect(chargesAfterCancel([c("City Power", "2026-07-16", 48.2, "checking")], [power])).toHaveLength(1);
  });

  it("raises no other alerts for a cancelled series", () => {
    const status = new Map([[seriesKey("Streamflix", "card"), "cancelled" as const]]);
    const series = detectSeries(monthly("Streamflix", MONTHS, [15.49, 15.49, 15.49, 15.49, 15.49, 17.99]), TODAY);
    expect(alertsFor(series, status, TODAY)).toEqual([]);
  });
});

describe("renewal heads-up (#84)", () => {
  // A yearly cloud storage plan: next charge expected 2027-03-12.
  const plan = () => monthly("Cloudbox", ["2025-03-10", "2026-03-12"], 99);
  const confirmed = new Map([[seriesKey("Cloudbox", "card"), "confirmed" as const]]);
  const renewals = (charges: Charge[], on: string, status = confirmed) =>
    alertsFor(detectSeries(charges, on), status, on).filter((a) => a.kind === "upcoming_renewal");

  it("raises nothing 30 days out, then exactly one from 14 days out", () => {
    expect(renewals(plan(), "2027-02-10")).toEqual([]);
    expect(renewals(plan(), "2027-02-25")).toEqual([]); // 15 days
    const keys = new Set(["2027-02-26", "2027-03-01", "2027-03-12"].flatMap((on) => renewals(plan(), on).map((a) => a.dedupeKey)));
    expect([...keys]).toEqual([`upcoming_renewal|${seriesKey("Cloudbox", "card")}|2027-03-12`]);
    expect(renewals(plan(), "2027-02-26")[0]).toMatchObject({ occurredOn: "2027-03-12", toCents: 9_900, cadence: "annual", variable: false });
  });

  it("only for tracked bills that renew quarterly or less often", () => {
    expect(renewals(plan(), "2027-03-01", new Map())).toEqual([]);
    const tunebox = monthly("Tunebox", MONTHS, 10.99);
    expect(renewals(tunebox, "2026-06-25", new Map([[seriesKey("Tunebox", "card"), "confirmed" as const]]))).toEqual([]);
    const quarterly = monthly("Water Co", ["2025-12-01", "2026-03-02", "2026-06-01"], [48.1, 61.2, 72.4]);
    const [water] = renewals(quarterly, "2026-08-25", new Map([[seriesKey("Water Co", "card"), "confirmed" as const]]));
    expect(water).toMatchObject({ occurredOn: "2026-09-01", variable: true });
  });
});
