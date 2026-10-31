import { describe, expect, it } from "vitest";
import { dailyContributions } from "./net-worth";
import { changeOver, groupSeries, rangeStart, sumSeries, type BreakdownAccount } from "./net-worth-breakdown";

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
