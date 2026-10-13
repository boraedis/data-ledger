import { describe, expect, it } from "vitest";
import { findMatches, isStale } from "@/lib/provisional/match";

const at = (iso: string) => new Date(iso);
const alert = (id: string, postedOn: string, amountCents = -1250, accountId = "card") => ({ id, accountId, amountCents, postedOn, createdAt: at(`${postedOn}T18:00:00Z`) });
const bank = (id: string, postedOn: string, amountCents = -1250, accountId = "card", arrived = `${postedOn}T23:00:00Z`) => ({
  id,
  accountId,
  amountCents,
  postedOn,
  createdAt: at(arrived),
});

describe("findMatches", () => {
  it("matches the same account and amount within the window, closest date first", () => {
    expect(findMatches([alert("p", "2026-07-01")], [bank("late", "2026-07-05"), bank("near", "2026-07-02")])).toEqual([
      { provisionalId: "p", transactionId: "near" },
    ]);
    // A day early is a time zone; six days late is too far.
    expect(findMatches([alert("p", "2026-07-02")], [bank("b", "2026-07-01", -1250, "card", "2026-07-03T09:00:00Z")])).toHaveLength(1);
    expect(findMatches([alert("p", "2026-07-01")], [bank("b", "2026-07-07")])).toEqual([]);
  });

  it("never matches across accounts or amounts", () => {
    expect(findMatches([alert("p", "2026-07-01")], [bank("b", "2026-07-02", -1250, "checking"), bank("c", "2026-07-02", -1500)])).toEqual([]);
  });

  it("ignores a synced row that was already there when the alert came", () => {
    expect(findMatches([alert("p", "2026-07-01")], [bank("old", "2026-07-01", -1250, "card", "2026-07-01T08:00:00Z")])).toEqual([]);
  });

  it("pairs identical purchases one to one, in date order", () => {
    const pairs = findMatches([alert("second", "2026-07-02"), alert("first", "2026-07-01")], [bank("b2", "2026-07-03"), bank("b1", "2026-07-02")]);
    expect(pairs).toEqual([
      { provisionalId: "first", transactionId: "b1" },
      { provisionalId: "second", transactionId: "b2" },
    ]);
  });
});

it("calls a purchase stale after a week", () => {
  expect(isStale("2026-07-01", "2026-07-08")).toBe(false);
  expect(isStale("2026-07-01", "2026-07-09")).toBe(true);
});
