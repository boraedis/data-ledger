import { describe, expect, it } from "vitest";
import { alertsFor, detectSeries, seriesKey, type Charge } from "@/lib/recurring/detect";

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

  it("raises nothing for a dismissed series", () => {
    const dismissed = new Map([[seriesKey("Streamflix", "card"), "dismissed" as const]]);
    expect(kinds(monthly("Streamflix", MONTHS, [15.49, 15.49, 15.49, 15.49, 15.49, 17.99]), dismissed)).toEqual([]);
  });
});
