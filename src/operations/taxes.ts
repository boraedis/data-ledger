import { eq } from "drizzle-orm";
import { z } from "zod";
import { filingStatus, hsaCoverage, payStubEmployerLines, payStubLines, payStubs, taxAssumptions } from "@/db/schema";
import { DEFAULT_ASSUMPTIONS, estimateYear, type Assumptions } from "@/lib/taxes/estimate";
import { FEDERAL } from "@/lib/taxes/tables";
import { defineRead, defineWrite } from "@/operations/define";

// The tax estimate (#61): the year's position from pay stubs (#60) and the
// owner's own assumptions. Owner only: neither is offered to Tally, so no
// part of it reaches the model (the issue's rule, stricter than pay stubs
// themselves). Pages call these through read() and executeAsOwner.

const cents = z.number().int().min(0);

export const setTaxAssumptions = defineWrite({
  name: "taxes.setAssumptions",
  description:
    "Set the owner's inputs to a year's tax estimate: filing status, other income, itemized deductions, credits, other payments, " +
    "and HSA coverage (self or family, null for none) with the 55-or-older catch-up.",
  allowedActors: ["user"],
  input: z.object({
    year: z.number().int().min(2000).max(2100),
    filingStatus: z.enum(filingStatus.enumValues),
    otherIncomeCents: cents,
    // Null takes the standard deduction.
    itemizedDeductionsCents: cents.nullable(),
    creditsCents: cents,
    otherPaymentsCents: cents,
    hsaCoverage: z.enum(hsaCoverage.enumValues).nullable().default(null),
    hsaCatchUp: z.boolean().default(false),
  }),
  apply: async (ctx, { year, ...values }) => {
    const [existing] = await ctx.db.select({ id: taxAssumptions.id }).from(taxAssumptions).where(eq(taxAssumptions.year, year));
    if (existing) return ctx.update(taxAssumptions, existing.id, values);
    return ctx.insert(taxAssumptions, { year, ...values });
  },
});

export const taxEstimate = defineRead({
  name: "taxes.estimate",
  description: "A year's tax estimate from pay stubs and the owner's assumptions.",
  allowedActors: ["user"],
  input: z.object({ year: z.number().int().min(2000).max(2100) }),
  run: async (db, { year }) => {
    const [stubs, lines, employerLines, [saved]] = await Promise.all([
      db.select().from(payStubs),
      db.select({ payStubId: payStubLines.payStubId, kind: payStubLines.kind, amountCents: payStubLines.amountCents }).from(payStubLines),
      db
        .select({ payStubId: payStubEmployerLines.payStubId, kind: payStubEmployerLines.kind, amountCents: payStubEmployerLines.amountCents })
        .from(payStubEmployerLines),
      db.select().from(taxAssumptions).where(eq(taxAssumptions.year, year)),
    ]);
    const assumptions: Assumptions = saved
      ? {
          filingStatus: saved.filingStatus,
          otherIncomeCents: saved.otherIncomeCents,
          itemizedDeductionsCents: saved.itemizedDeductionsCents,
          creditsCents: saved.creditsCents,
          otherPaymentsCents: saved.otherPaymentsCents,
          hsaCoverage: saved.hsaCoverage,
          hsaCatchUp: saved.hsaCatchUp,
        }
      : DEFAULT_ASSUMPTIONS;
    const estimate = estimateYear(
      year,
      stubs.map((s) => ({ ...s, lines: lines.filter((l) => l.payStubId === s.id), employer: employerLines.filter((l) => l.payStubId === s.id) })),
      assumptions,
    );
    return { year, assumptions, saved: Boolean(saved), hasTables: year in FEDERAL, estimate };
  },
});
