import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, forecast, forecastStart, parseAssumptions, type ForecastAssumptions } from "./forecast";

// The net worth forecast (#233). Balances and rates invented.

const start = { cash: 2_000_000, investments: 5_000_000, other: 1_000_000, debts: -300_000 };
const with_ = (a: Partial<Omit<ForecastAssumptions, "ratesPct">> & { ratesPct?: Partial<ForecastAssumptions["ratesPct"]> }): ForecastAssumptions => ({
  ...DEFAULT_ASSUMPTIONS,
  ...a,
  ratesPct: { ...DEFAULT_ASSUMPTIONS.ratesPct, ...a.ratesPct },
});

describe("forecast (#233)", () => {
  it("starts at today's net worth and, with no growth or additions, stays there", () => {
    const points = forecast(start, DEFAULT_ASSUMPTIONS, "2026-11-02");
    expect(points).toHaveLength(10 * 12 + 1);
    expect(points[0]).toMatchObject({ on: "2026-11-02", cents: 7_700_000 });
    expect(points.at(-1)).toMatchObject({ on: "2036-11-02", cents: 7_700_000 });
  });

  it("compounds monthly to the yearly rate, and adds the monthly amount to investments", () => {
    const grown = forecast(start, with_({ ratesPct: { investments: 12 }, years: 1 }), "2026-11-02").at(-1)!;
    expect(grown.groups.investments).toBe(5_600_000);
    const saved = forecast(start, with_({ monthlyCents: 50_000, years: 2 }), "2026-11-02").at(-1)!;
    expect(saved.groups.investments).toBe(5_000_000 + 24 * 50_000);
  });

  it("changes only what an input touches", () => {
    const base = forecast(start, with_({ ratesPct: { investments: 6 }, monthlyCents: 50_000 }), "2026-11-02");
    const moreCash = forecast(start, with_({ ratesPct: { investments: 6, cash: 3 }, monthlyCents: 50_000 }), "2026-11-02");
    expect(moreCash.map((p) => p.groups.investments)).toEqual(base.map((p) => p.groups.investments));
    expect(moreCash.map((p) => p.groups.other)).toEqual(base.map((p) => p.groups.other));
    expect(moreCash.at(-1)!.groups.cash).toBeGreaterThan(base.at(-1)!.groups.cash);
    // Debts never move.
    expect(new Set(moreCash.map((p) => p.groups.debts))).toEqual(new Set([-300_000]));
  });

  it("steps month by month, keeping a month-end date inside shorter months", () => {
    const points = forecast(start, with_({ years: 1 }), "2026-01-31");
    expect(points.slice(0, 4).map((p) => p.on)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});

describe("forecastStart", () => {
  it("groups accounts by kind, debts negative", () => {
    expect(
      forecastStart([
        { kind: "checking", contributionCents: 100 },
        { kind: "savings", contributionCents: 200 },
        { kind: "retirement", contributionCents: 1_000 },
        { kind: "brokerage", contributionCents: 500 },
        { kind: "other_asset", contributionCents: 50 },
        { kind: "credit", contributionCents: -80 },
        { kind: "loan", contributionCents: -20 },
      ]),
    ).toEqual({ cash: 300, investments: 1_500, other: 50, debts: -100 });
  });
});

describe("parseAssumptions", () => {
  it("reads the URL, clamping what's out of range and defaulting what isn't a number", () => {
    expect(parseAssumptions({ cash: "2.5", inv: "7", other: "-1", add: "$1,250", years: "25" })).toEqual({
      ratesPct: { cash: 2.5, investments: 7, other: -1 },
      monthlyCents: 125_000,
      years: 25,
    });
    expect(parseAssumptions({ inv: "500", add: "-3", years: "90" })).toMatchObject({ ratesPct: { investments: 50 }, monthlyCents: 0, years: 40 });
    expect(parseAssumptions({ inv: "lots", years: "" })).toEqual(DEFAULT_ASSUMPTIONS);
  });
});
