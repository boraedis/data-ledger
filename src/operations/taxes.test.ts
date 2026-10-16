import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { toolSpecs } from "@/lib/tally/tools";
import { testDb } from "@/lib/test-utils/db";
import { execute, read } from "@/operations/runtime";
import { taxEstimate } from "@/operations/taxes";

// The tax estimate over the seed's three synthetic pay stubs (June 2026).

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
});

const assumptions = { year: 2026, filingStatus: "married_joint", otherIncomeCents: 50_000, itemizedDeductionsCents: null, creditsCents: 0, otherPaymentsCents: 0 };

it("estimates from the pay stubs with default assumptions, then with the owner's", async () => {
  const before = await read(db, taxEstimate, { year: 2026 });
  expect(before).toMatchObject({ saved: false, hasTables: true, assumptions: { filingStatus: "single" } });
  expect(before.estimate).toMatchObject({ stubCount: 3, cadenceDays: 14 });
  expect(before.estimate!.taxes.map((t) => t.kind)).toEqual(["federal_income_tax", "state_income_tax", "social_security", "medicare"]);

  await execute(db, { operation: "taxes.setAssumptions", actor: "user", reason: "Test", input: assumptions });
  const after = await read(db, taxEstimate, { year: 2026 });
  expect(after).toMatchObject({ saved: true, assumptions: { filingStatus: "married_joint", otherIncomeCents: 50_000 } });
  // A joint return's wider brackets owe less on the same pay.
  expect(after.estimate!.federal!.liabilityCents).toBeLessThan(before.estimate!.federal!.liabilityCents);

  // Saving again updates the year's row rather than adding one.
  await execute(db, { operation: "taxes.setAssumptions", actor: "user", reason: "Test", input: { ...assumptions, creditsCents: 100_000 } });
  expect((await read(db, taxEstimate, { year: 2026 })).assumptions.creditsCents).toBe(100_000);
});

it("is the owner's alone: never a Tally tool, and refused to Tally", async () => {
  const names = toolSpecs().map((t) => t.name);
  expect(names).not.toContain("taxes__estimate");
  expect(names).not.toContain("taxes__setAssumptions");
  await expect(execute(db, { operation: "taxes.estimate", actor: "tally", reason: "Test", input: { year: 2026 } })).rejects.toThrow();
});

it("says so when a year has no stubs", async () => {
  expect((await read(db, taxEstimate, { year: 2025 })).estimate).toBeNull();
});
