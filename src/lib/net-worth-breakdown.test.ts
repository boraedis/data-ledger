import { describe, expect, it } from "vitest";
import { dailyContributions } from "./net-worth";
import { changeOver, groupSeries, rangeStart, stackDay, stackSides, sumSeries, type BreakdownAccount } from "./net-worth-breakdown";

// Made-up accounts: checking $1,000, savings $4,000 and a $500 card balance
// at Example Bank; a brokerage account starting later elsewhere.
const accounts: BreakdownAccount[] = [
  { id: "chk", name: "Everyday Checking", institution: "Example Bank", kind: "checking" },
  { id: "sav", name: "Rainy Day", institution: "Example Bank", kind: "savings" },
  { id: "card", name: "Rewards Card", institution: "Example Bank", kind: "credit" },
  { id: "brk", name: "Index Fund", institution: "Sample Brokerage", kind: "brokerage" },
];
const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
const snapshots = [
  { accountId: "chk", on: "2026-10-01", balanceCents: 100_000 },
  { accountId: "sav", on: "2026-10-01", balanceCents: 400_000 },
  // Reported as a positive balance owed; counts below zero.
  { accountId: "card", on: "2026-10-01", balanceCents: 50_000 },
  { accountId: "brk", on: "2026-10-03", balanceCents: 200_000 },
  { accountId: "chk", on: "2026-10-04", balanceCents: 120_000 },
];
const daily = dailyContributions(kinds, snapshots, "2026-10-05");

describe("net worth breakdown (#134)", () => {
  it("stacks to $4,500 with the card below zero, and leaves an account blank before its first balance", () => {
    expect(daily.days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(daily.byAccount.card[0]).toBe(-50_000);
    expect(daily.byAccount.brk.slice(0, 3)).toEqual([null, null, 200_000]);
    const total = sumSeries(Object.values(daily.byAccount), daily.days.length);
    expect(total[0]).toBe(450_000);
    // Checking up to $1,200 and the brokerage's $2,000 joined.
    expect(total.at(-1)).toBe(670_000);
  });

  it("gives the same total whichever way it's grouped", () => {
    const total = sumSeries(Object.values(daily.byAccount), daily.days.length);
    for (const by of ["kind", "account", "institution"] as const) {
      const groups = groupSeries(accounts, daily, by);
      expect(sumSeries(groups.map((g) => g.values), daily.days.length)).toEqual(total);
    }
    expect(groupSeries(accounts, daily, "institution").map((g) => g.label)).toEqual(["Example Bank", "Sample Brokerage"]);
  });

  it("folds the smallest groups into Other past the cap, keeping the total", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, name: `Account ${i}`, institution: "X", kind: "checking" as const }));
    const d = dailyContributions(new Map(many.map((a) => [a.id, a.kind])), many.map((a, i) => ({ accountId: a.id, on: "2026-10-01", balanceCents: (i + 1) * 1_000 })), "2026-10-01");
    const groups = groupSeries(many, d, "account");
    expect(groups).toHaveLength(8);
    expect(groups.at(-1)!.label).toBe("Other (3)");
    expect(sumSeries(groups.map((g) => g.values), 1)[0]).toBe(55_000);
  });

  it("starts each range on its own first day and measures the change from the first value in it", () => {
    expect(rangeStart("1m", "2026-10-30", "2026-04-01")).toBe("2026-09-30");
    expect(rangeStart("ytd", "2026-10-30", "2026-04-01")).toBe("2026-01-01");
    expect(rangeStart("all", "2026-10-30", "2026-04-01")).toBe("2026-04-01");
    const total = sumSeries(Object.values(daily.byAccount), daily.days.length);
    // Over "all", from Oct 1's $4,500 to Oct 5's $6,700.
    expect(changeOver(daily.days, total, "2026-10-01")).toEqual({ since: "2026-10-01", startCents: 450_000, endCents: 670_000, changeCents: 220_000 });
    // A year back is before history: measured from its first day.
    expect(changeOver(daily.days, total, "2025-10-05")!.since).toBe("2026-10-01");
    // The brokerage group only from its own first balance.
    expect(changeOver(daily.days, daily.byAccount.brk, "2026-10-01")!.since).toBe("2026-10-03");
  });
});

// A card that is paid off keeps its place in the stack (#195). Synthetic values.
describe("stacking", () => {
  const checking = [100_000, 100_000, 100_000, 100_000, 100_000];
  // $500 owed, paid to $0 for two days, then $200 owed again.
  const card = [-50_000, -50_000, 0, 0, -20_000];

  it("takes a zero day's side from the nearest day with a balance", () => {
    expect(stackSides(card)).toEqual(["down", "down", "down", "down", "down"]);
    expect(stackSides([null, null, 0, 300, 0])).toEqual(["up", "up", "up", "up", "up"]);
    // Before the first balance, the first balance's side.
    expect(stackSides([null, 0, -100, 0])).toEqual(["down", "down", "down", "down"]);
    // A group that changes sign changes side; zero follows the earlier day.
    expect(stackSides([100, 0, -100, 0])).toEqual(["up", "up", "down", "down"]);
    expect(stackSides([null, null])).toEqual(["up", "up"]);
  });

  it("narrows a paid-off card to nothing below zero, not at the top of the assets", () => {
    const sides = [stackSides(checking), stackSides(card)];
    const day = (d: number) => stackDay([checking[d], card[d]], [sides[0][d], sides[1][d]]);
    expect(day(1)).toEqual([{ y0: 0, y1: 100_000 }, { y0: 0, y1: -50_000 }]);
    // $500 owed → $0: zero width at the owed edge of the stack.
    expect(day(2)).toEqual([{ y0: 0, y1: 100_000 }, { y0: 0, y1: 0 }]);
    // Owing again picks up from the same place.
    expect(day(4)[1]).toEqual({ y0: 0, y1: -20_000 });
  });

  it("keeps the order among the owed when a card in the middle is paid off", () => {
    const loan = [-300_000, -300_000, -300_000];
    const mid = [-50_000, 0, -50_000];
    const days = [0, 1, 2].map((d) => stackDay([loan[d], mid[d]], [stackSides(loan)[d], stackSides(mid)[d]]));
    // The second owed group sits just under the first, and is flat there at zero.
    expect(days[1][1]).toEqual({ y0: -300_000, y1: -300_000 });
    expect(days[2][1]).toEqual({ y0: -300_000, y1: -350_000 });
  });

  it("adds up to the day's net worth", () => {
    const sides = [stackSides(checking), stackSides(card)];
    for (let d = 0; d < 5; d++) {
      const bands = stackDay([checking[d], card[d]], [sides[0][d], sides[1][d]]);
      expect(bands.reduce((sum, b) => sum + (b.y1 - b.y0), 0)).toBe(checking[d] + card[d]);
    }
  });
});
