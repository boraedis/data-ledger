import { describe, expect, it } from "vitest";
import { valueChange } from "./investments";

const snap = (accountId: string, on: string, balanceCents: number) => ({ accountId, on, balanceCents });

describe("investment value change (#169)", () => {
  it("is each account's balance at the end less the day before the start, summed", () => {
    const snapshots = [snap("brokerage", "2025-12-31", 1_000_000), snap("brokerage", "2026-06-30", 1_080_000), snap("ira", "2025-12-30", 500_000), snap("ira", "2026-06-29", 490_000)];
    expect(valueChange(snapshots, "2026-01-01", "2026-06-30")).toBe(80_000 - 10_000);
  });

  it("counts an account opened during the period from zero, and is null with no balances", () => {
    expect(valueChange([snap("new", "2026-03-15", 20_000)], "2026-01-01", "2026-06-30")).toBe(20_000);
    expect(valueChange([], "2026-01-01", "2026-06-30")).toBeNull();
  });
});
