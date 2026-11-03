import { describe, expect, it } from "vitest";
import { enoughForChart, payPoints, rangeStart, type PayStubForChart } from "./chart";

// Made-up stubs at two made-up employers.
const stub = (payDate: string, netCents: number, over: Partial<PayStubForChart> = {}): PayStubForChart => ({
  payDate,
  employer: "Acme Widgets",
  grossCents: netCents + 1000,
  netCents,
  oneTime: false,
  lines: [{}],
  totals: { tax: 700, insurance: 200, retirement: 100, other: 0 },
  ...over,
});

describe("payPoints", () => {
  it("averages the three regular paychecks before, once there are three", () => {
    const p = payPoints([stub("2026-01-15", 3000), stub("2026-01-01", 2000), stub("2026-01-29", 4000), stub("2026-02-12", 5000)]);
    expect(p.map((x) => x.payDate)).toEqual(["2026-01-01", "2026-01-15", "2026-01-29", "2026-02-12"]);
    expect(p.map((x) => x.typicalNetCents)).toEqual([null, null, null, 3000]);
  });

  it("keeps a bonus and a net-only stub out of the typical, as points of their own", () => {
    const p = payPoints([
      stub("2026-01-01", 2000),
      stub("2026-01-15", 2000),
      stub("2026-01-15", 90000, { oneTime: true }),
      stub("2026-01-20", 1500, { grossCents: 1500, lines: [], totals: { tax: 0, insurance: 0, retirement: 0, other: 0 } }),
      stub("2026-01-29", 2600),
      stub("2026-02-12", 2600),
    ]);
    expect(p.map((x) => x.kind)).toEqual(["regular", "regular", "oneTime", "netOnly", "regular", "regular"]);
    expect(p.at(-1)!.typicalNetCents).toBe(2200);
    // An odd point still reads against what a regular paycheck has been.
    expect(p[2].typicalNetCents).toBeNull();
  });

  it("makes two employers' stubs on one day one paycheck, its groups adding up to gross less net", () => {
    const [p] = payPoints([stub("2026-03-01", 2000), stub("2026-03-01", 1000, { employer: "Bramble Co" })]);
    expect(p.employers).toEqual(["Acme Widgets", "Bramble Co"]);
    expect(p.netCents).toBe(3000);
    expect(p.grossCents - p.netCents).toBe(Object.values(p.groups).reduce((s, n) => s + n, 0));
  });

  it("needs three regular paychecks for a chart", () => {
    expect(enoughForChart(payPoints([stub("2026-01-01", 1), stub("2026-01-15", 1), stub("2026-01-20", 1, { oneTime: true })]))).toBe(false);
    expect(enoughForChart(payPoints([stub("2026-01-01", 1), stub("2026-01-15", 1), stub("2026-01-29", 1)]))).toBe(true);
  });
});

describe("rangeStart", () => {
  it("starts this year, a year back, or at the beginning", () => {
    expect(rangeStart("year", "2026-11-03")).toBe("2026-01-01");
    expect(rangeStart("12", "2026-11-03")).toBe("2025-11-03");
    expect(rangeStart("all", "2026-11-03") < "1900").toBe(true);
  });
});
