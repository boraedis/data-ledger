import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { toolSpecs } from "@/lib/tally/tools";
import { testDb } from "@/lib/test-utils/db";
import { execute, read } from "@/operations/runtime";
import { listPayStubs } from "@/operations/pay";
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

it("saves HSA coverage, which sets the limit the estimate checks against (#92)", async () => {
  await execute(db, { operation: "taxes.setAssumptions", actor: "user", reason: "Test", input: { ...assumptions, hsaCoverage: "family", hsaCatchUp: true } });
  const { assumptions: saved } = await read(db, taxEstimate, { year: 2026 });
  expect(saved).toMatchObject({ hsaCoverage: "family", hsaCatchUp: true });
  // Left out, as by an older client: no HSA plan.
  await execute(db, { operation: "taxes.setAssumptions", actor: "user", reason: "Test", input: assumptions });
  expect((await read(db, taxEstimate, { year: 2026 })).assumptions).toMatchObject({ hsaCoverage: null, hsaCatchUp: false });
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

it("leaves a stub flagged one-time out of the pace, keeps the flag on an edit that omits it, and shows it (#113)", async () => {
  type Stub = { id: string; employer: string; periodStart: string; periodEnd: string; payDate: string; grossCents: number; netCents: number; oneTime: boolean; lines: { kind: string; label: string; amountCents: number; categoryId: string | null }[]; employerLines: { kind: string; label: string; amountCents: number }[] };
  const list = async () => (await read(db, listPayStubs, { year: 2026 })) as unknown as Stub[];
  const [latest] = await list();
  expect(latest.oneTime).toBe(false);
  const fields = (s: Stub) => ({
    payStubId: s.id,
    employer: s.employer,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    payDate: s.payDate,
    grossCents: s.grossCents,
    netCents: s.netCents,
    lines: s.lines,
    employerLines: s.employerLines,
  });
  const before = (await read(db, taxEstimate, { year: 2026 })).estimate!;

  await execute(db, { operation: "payStubs.update", actor: "user", reason: "Test", input: { ...fields(latest), oneTime: true } });
  const after = (await read(db, taxEstimate, { year: 2026 })).estimate!;
  expect(after).toMatchObject({ stubCount: 3, oneTimeCount: 1 });
  // Same year to date; the pace now comes from the two regular stubs.
  expect(after.gross.ytdCents).toBe(before.gross.ytdCents);
  expect(after.lastPayDate < latest.payDate).toBe(true);

  // An edit that doesn't mention it keeps it.
  await execute(db, { operation: "payStubs.update", actor: "user", reason: "Test", input: fields(latest) });
  expect((await list()).find((s) => s.id === latest.id)!.oneTime).toBe(true);
});
