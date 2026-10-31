import { describe, expect, it } from "vitest";
import { averageShareUsed, burndown, daysOf, spendCalendar } from "./burndown";

// Invented: a $1,000 target over a 30-day month.
const september = (lines: { date: string; amountCents: number }[], availableCents = 100_000) => ({ start: "2026-09-01", end: "2026-09-30", availableCents, lines });

describe("burndown (#149)", () => {
  it("shows $600 left on day 10 after $400 spent, against $667 on the straight line", () => {
    const b = burndown(september([{ date: "2026-09-03", amountCents: -25_000 }, { date: "2026-09-10", amountCents: -15_000 }]), "2026-09-10");
    const day10 = b.days[9];
    expect(day10).toMatchObject({ date: "2026-09-10", leftCents: 60_000, idealCents: 66_667 });
    expect(b.days[0].idealCents).toBe(96_667);
    expect(b.days.at(-1)!.idealCents).toBe(0);
    // Days still to come have no actual line.
    expect(b.days[10].leftCents).toBeNull();
  });

  it("counts a refund back into what's left", () => {
    const b = burndown(september([{ date: "2026-09-02", amountCents: -20_000 }, { date: "2026-09-04", amountCents: 5_000 }]), "2026-09-30");
    expect(b.days[3].leftCents).toBe(85_000);
  });

  it("averages the same days of past periods as a share of each one's target", () => {
    // August: a $500 target, half used by day 10. July: $1,000, a quarter by day 10.
    const august = { start: "2026-08-01", end: "2026-08-31", availableCents: 50_000, lines: [{ date: "2026-08-05", amountCents: -25_000 }] };
    const july = { start: "2026-07-01", end: "2026-07-31", availableCents: 100_000, lines: [{ date: "2026-07-08", amountCents: -25_000 }] };
    const b = burndown(september([]), "2026-09-10", [august, july]);
    expect(b.pastPeriods).toBe(2);
    // (50% + 25%) / 2 used by day 10: $625 used of this month's $1,000.
    expect(b.days[9].typicalCents).toBe(62_500);
  });

  it("holds a shorter past period at its last day", () => {
    const february = { start: "2026-02-01", end: "2026-02-28", availableCents: 10_000, lines: [{ date: "2026-02-28", amountCents: -10_000 }] };
    const avg = averageShareUsed([february], 31);
    expect(avg.share[27]).toBe(1);
    expect(avg.share[30]).toBe(1);
  });

  it("has no average without past periods with a budget", () => {
    expect(burndown(september([]), "2026-09-10").days[0].typicalCents).toBeNull();
    expect(burndown(september([]), "2026-09-10", [{ start: "2026-08-01", end: "2026-08-31", availableCents: 0, lines: [] }]).pastPeriods).toBe(0);
  });
});

describe("spendCalendar (#149)", () => {
  it("leaves a day with no spending unshaded and shades the rest against the even share", () => {
    // $1,000 over 30 days: $33.33 a day.
    const c = spendCalendar(september([{ date: "2026-09-02", amountCents: -1_000 }, { date: "2026-09-03", amountCents: -3_000 }, { date: "2026-09-04", amountCents: -5_000 }, { date: "2026-09-05", amountCents: -9_000 }]), "2026-09-10");
    expect(c.share).toBe(3_333);
    expect(c.days.slice(0, 5).map((d) => d.tone)).toEqual([null, "under", "near", "over", "far-over"]);
    expect(c.days[0].spentCents).toBe(0);
    // Still to come: no figure at all.
    expect(c.days[20]).toEqual({ date: "2026-09-21", spentCents: null, tone: null });
  });

  it("covers every day of the period", () => {
    expect(daysOf("2026-02-01", "2026-02-28")).toHaveLength(28);
    expect(daysOf("2026-01-01", "2026-12-31")).toHaveLength(365);
  });
});
