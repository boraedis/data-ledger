import { expect, it } from "vitest";
import { federalTax } from "@/lib/taxes/tables";

it("applies the brackets progressively", () => {
  // 2026 single: 10% of 12,400 + 12% of (50,000 - 12,400).
  expect(federalTax(2026, "single", 5_000_000)).toBe(124_000 + 451_200);
  // Into the 22% bracket for a joint return.
  expect(federalTax(2026, "married_joint", 12_000_000)).toBe(248_000 + 912_000 + 422_400);
  expect(federalTax(2026, "single", 0)).toBe(0);
});

it("knows nothing about a year it has no table for", () => {
  expect(federalTax(2031, "single", 5_000_000)).toBeNull();
});
