import { describe, expect, it } from "vitest";
import { goalProgress, type GoalInput } from "@/lib/goals/progress";

// All amounts invented.

const goal = (overrides: Partial<GoalInput>): GoalInput => ({
  id: "g",
  name: "Emergency fund",
  targetCents: 1_000_000,
  targetDate: "2026-12-31",
  startOn: "2026-01-01",
  tagName: null,
  linked: [],
  tagged: [],
  ...overrides,
});

describe("goalProgress", () => {
  it("counts linked balances, carried forward between snapshots, with today at the current balance", () => {
    const p = goalProgress(
      goal({
        linked: [{ id: "sav", name: "Savings", currentCents: 600_000, snapshots: [{ on: "2025-12-20", cents: 200_000 }, { on: "2026-03-01", cents: 400_000 }] }],
      }),
      "2026-04-10",
    );
    expect(p.startCents).toBe(200_000);
    expect(p.series.find((d) => d.on === "2026-02-15")!.cents).toBe(200_000);
    expect(p.series.find((d) => d.on === "2026-03-01")!.cents).toBe(400_000);
    expect(p.currentCents).toBe(600_000);
    expect(p.share).toBeCloseTo(0.6);
  });

  it("counts tagged transfers out as contributions, except in linked accounts", () => {
    const p = goalProgress(
      goal({
        targetDate: null,
        linked: [{ id: "sav", name: "Savings", currentCents: 0, snapshots: [] }],
        tagged: [
          { date: "2026-02-01", amountCents: -30_000, accountId: "chk" },
          { date: "2026-03-01", amountCents: -30_000, accountId: "chk" },
          { date: "2026-03-01", amountCents: 30_000, accountId: "sav" }, // the receiving side: already in the balance
          { date: "2026-03-15", amountCents: 10_000, accountId: "chk" }, // taken back
        ],
      }),
      "2026-04-01",
    );
    expect(p.currentCents).toBe(50_000);
  });

  it("is on track at an even pace from the start, behind when short of it", () => {
    const linked = (cents: number) => [{ id: "sav", name: "Savings", currentCents: cents, snapshots: [{ on: "2026-01-01", cents: 0 }] }];
    // Half-way through the year (182/365 days), half the target is the pace.
    const onTrack = goalProgress(goal({ linked: linked(500_000) }), "2026-07-01");
    expect(onTrack.status.kind).toBe("on_track");
    const behind = goalProgress(goal({ linked: linked(300_000) }), "2026-07-01");
    expect(behind.status).toMatchObject({ kind: "behind", shortCents: Math.round(1_000_000 * (182 / 365)) - 300_000 });
    expect(behind.monthlyNeededCents).toBe(Math.ceil(700_000 / 6));
  });

  it("reports reached, overdue, and a projection when there's no date", () => {
    const linked = (cents: number) => [{ id: "sav", name: "Savings", currentCents: cents, snapshots: [{ on: "2026-01-01", cents: 0 }] }];
    expect(goalProgress(goal({ linked: linked(1_000_000) }), "2026-07-01").status.kind).toBe("reached");
    expect(goalProgress(goal({ targetDate: "2026-06-30", linked: linked(10) }), "2026-07-01").status.kind).toBe("overdue");
    // $1,000 a day for 100 days, $900,000 to go → about 900 days out.
    const steady = goalProgress(
      goal({
        targetDate: null,
        startOn: "2026-01-01",
        tagged: Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), amountCents: -1_000, accountId: "chk" })),
      }),
      "2026-04-10",
    );
    expect(steady.status.kind).toBe("no_date");
    // A goal set today still sees the saving that came before it.
    const fresh = goalProgress(
      goal({
        targetDate: null,
        startOn: "2026-04-10",
        tagged: [
          { date: "2026-02-15", amountCents: -30_000, accountId: "chk" },
          { date: "2026-03-15", amountCents: -30_000, accountId: "chk" },
        ],
      }),
      "2026-04-10",
    );
    expect(fresh).toMatchObject({ currentCents: 60_000, series: [{ on: "2026-04-10", cents: 60_000 }] });
    expect(fresh.status).toMatchObject({ kind: "no_date", projectedOn: expect.any(String) });
    expect(steady.status).toMatchObject({ projectedOn: expect.stringMatching(/^2028-/) });
  });

  it("gives the pace now and along the way, and an average per month once a month has passed", () => {
    const p = goalProgress(
      goal({ targetCents: 600_000, linked: [{ id: "sav", name: "Savings", currentCents: 200_000, snapshots: [{ on: "2026-01-01", cents: 100_000 }] }] }),
      "2026-05-01",
    );
    // A straight line from $1,000 to $6,000 across the year: 121 of 365 days in.
    const paceNow = Math.round(100_000 + 500_000 * (121 / 365));
    expect(p.paceNowCents).toBe(paceNow);
    expect(p.pace!.find((d) => d.on === "2026-05-01")!.cents).toBe(paceNow);
    // The start day counts as one day in (the pace counts the day itself), so it's a day's worth above the start.
    expect(p.pace!.find((d) => d.on === "2026-01-01")!.cents).toBe(Math.round(100_000 + 500_000 * (1 / 365)));
    // $1,000 gained over 121 days, about four months.
    expect(p.averagePerMonthCents).toBe(Math.round(100_000 / (121 / (365.25 / 12))));
  });

  it("has no pace line without a target date, and no average before a month has passed", () => {
    const p = goalProgress(
      goal({ targetDate: null, linked: [{ id: "sav", name: "Savings", currentCents: 20_000, snapshots: [{ on: "2026-01-01", cents: 10_000 }] }] }),
      "2026-01-10",
    );
    expect(p.paceNowCents).toBeNull();
    expect(p.pace).toBeNull();
    expect(p.averagePerMonthCents).toBeNull();
  });
});
