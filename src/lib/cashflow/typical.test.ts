import { describe, expect, it } from "vitest";
import { flowDays } from "@/lib/cashflow/series";
import { completeMonths, typicalDays, typicalMonths } from "@/lib/cashflow/typical";

// Synthetic days only: round invented amounts.

const month = (key: string, ins: [string, number][], outs: [string, number][]) => {
  const last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
  return flowDays(`${key}-01`, `${key}-${String(last).padStart(2, "0")}`, ins.map(([d, cents]) => ({ date: `${key}-${d}`, cents })), outs.map(([d, cents]) => ({ date: `${key}-${d}`, cents })));
};

describe("completeMonths", () => {
  const days = [...month("2025-12", [["15", 500_00]], [["10", 200_00]]), ...month("2026-01", [["15", 600_00]], [["10", 300_00]]), ...month("2026-02", [["15", 700_00]], [["10", 400_00]])];

  it("keeps whole months that began with the history and are over", () => {
    const found = completeMonths(days, { firstDay: "2025-12-01", today: "2026-02-10" });
    expect([...found.keys()]).toEqual(["2025-12", "2026-01"]);
    expect(found.get("2026-01")).toEqual({ inCents: 600_00, outCents: 300_00 });
  });

  it("leaves out a month history began part way through", () => {
    expect([...completeMonths(days, { firstDay: "2025-12-09", today: "2026-03-01" }).keys()]).toEqual(["2026-01", "2026-02"]);
  });

  it("leaves out a clipped period's partial month", () => {
    const clipped = flowDays("2026-01-10", "2026-01-31", [], []);
    expect(completeMonths(clipped, { firstDay: "2025-01-01", today: "2026-06-01" }).size).toBe(0);
  });
});

describe("typicalMonths", () => {
  const months = new Map([
    ["2025-11", { inCents: 300_00, outCents: 100_00 }],
    ["2025-12", { inCents: 600_00, outCents: 200_00 }],
    ["2026-01", { inCents: 900_00, outCents: 400_00 }],
  ]);

  it("averages the three months before each, looking back across the year", () => {
    const slots = typicalMonths("2026", months);
    expect(slots[0]).toBeNull(); // January's three before are Oct, Nov and Dec; Oct isn't there
    expect(slots[1]).toEqual({ inCents: 600_00, outCents: 233_33 }); // Feb: Nov, Dec and Jan
    expect(slots[2]).toBeNull(); // March needs February, which isn't over
    expect(slots.slice(3).every((s) => s === null)).toBe(true);
  });

  it("rounds an average to the cent", () => {
    const slots = typicalMonths("2026", new Map([...months, ["2025-10", { inCents: 100_00, outCents: 50_01 }]]));
    expect(slots[0]).toEqual({ inCents: 333_33, outCents: 116_67 });
  });
});

describe("typicalDays", () => {
  it("averages the three months' running totals by day, and a shorter month holds its final total", () => {
    const a = month("2026-01", [["02", 300_00]], [["03", 90_00]]); // 31 days
    const b = month("2026-02", [["02", 600_00]], [["03", 30_00]]); // 28 days
    const c = month("2026-03", [["02", 900_00]], [["30", 120_00]]); // 31 days
    const slots = typicalDays([a, b, c], 31)!;
    expect(slots).toHaveLength(31);
    expect(slots[0]).toEqual({ inCents: 0, outCents: 0 });
    expect(slots[1]).toEqual({ inCents: 600_00, outCents: 0 });
    expect(slots[2]).toEqual({ inCents: 600_00, outCents: 40_00 });
    // Day 31: Feb holds its day-28 total; March's out lands on the 30th.
    expect(slots[30]).toEqual({ inCents: 600_00, outCents: 80_00 });
  });

  it("needs exactly three months", () => {
    expect(typicalDays([month("2026-01", [], []), month("2026-02", [], [])], 31)).toBeNull();
  });
});
