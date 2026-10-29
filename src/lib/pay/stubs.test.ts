import { describe, expect, it } from "vitest";
import { depositMatches, expandDeposit, groupOf, stubMismatch, type DepositCandidate } from "@/lib/pay/stubs";

describe("stubMismatch", () => {
  it("passes a stub that adds up, and says by how much one doesn't", () => {
    expect(stubMismatch(300_000, [{ amountCents: 40_000 }, { amountCents: 15_000 }], 245_000)).toBeNull();
    expect(stubMismatch(300_000, [{ amountCents: 40_000 }], 245_000)).toMatch(/off by \$150\.00/);
  });
});

it("groups deductions so taxes are separate from insurance and retirement", () => {
  expect([groupOf("medicare"), groupOf("dental_insurance"), groupOf("retirement_pretax"), groupOf("fsa")]).toEqual(["tax", "insurance", "retirement", "other"]);
});

describe("depositMatches", () => {
  const PAYROLL = "Acme Widgets Payroll";
  const dep = (id: string, postedOn: string, amountCents: number, accountId = "checking", merchant: string | null = PAYROLL): DepositCandidate => ({ id, postedOn, amountCents, accountId, merchant });
  const ids = (deposits: DepositCandidate[], netCents = 245_000) => depositMatches({ payDate: "2026-06-12", netCents }, deposits).map((m) => m.map((d) => d.id));

  it("wants exactly the net near the pay date, closest first", () => {
    expect(ids([dep("far", "2026-06-20", 245_000), dep("late", "2026-06-13", 245_000), dep("on", "2026-06-12", 245_000), dep("other", "2026-06-12", 245_001)])).toEqual([
      ["on"],
      ["late"],
    ]);
  });

  it("finds pay split across accounts: same payer, one deposit per account, adding up to the net (#91)", () => {
    const split = [dep("checking", "2026-06-12", 195_000), dep("savings", "2026-06-12", 50_000, "savings"), dep("coffee", "2026-06-12", 50_000, "savings", "Corner Bean Cafe")];
    expect(ids(split)).toEqual([["checking", "savings"]]);
    // Three ways, largest first.
    expect(ids([dep("a", "2026-06-12", 150_000), dep("b", "2026-06-12", 70_000, "savings"), dep("c", "2026-06-13", 25_000, "hsa")])).toEqual([["a", "b", "c"]]);
  });

  it("doesn't split within one account, across payers, or outside the dates", () => {
    expect(ids([dep("a", "2026-06-12", 195_000), dep("b", "2026-06-12", 50_000)])).toEqual([]);
    expect(ids([dep("a", "2026-06-12", 195_000), dep("b", "2026-06-12", 50_000, "savings", "Paypeer Transfer")])).toEqual([]);
    expect(ids([dep("a", "2026-06-12", 195_000), dep("b", "2026-06-25", 50_000, "savings")])).toEqual([]);
    expect(ids([dep("a", "2026-06-12", 195_000), dep("b", "2026-06-12", 50_000, "savings", null)])).toEqual([]);
  });

  it("offers splits across differently named payers only when asked, for the owner to choose", () => {
    const deposits = [dep("a", "2026-06-12", 195_000, "checking", "Acme Payroll"), dep("b", "2026-06-12", 50_000, "savings", "Acme Widgets Dir Dep")];
    expect(ids(deposits)).toEqual([]);
    const any = depositMatches({ payDate: "2026-06-12", netCents: 245_000 }, deposits, { anyPayer: true });
    expect(any.map((m) => m.map((d) => d.id))).toEqual([["a", "b"]]);
    // Still one deposit per account.
    expect(depositMatches({ payDate: "2026-06-12", netCents: 245_000 }, [dep("a", "2026-06-12", 195_000), dep("b", "2026-06-12", 50_000, "checking", "Other")], { anyPayer: true })).toEqual([]);
  });

  it("lists every way that fits, so two of them leave the choice to the owner", () => {
    const deposits = [dep("c1", "2026-06-12", 195_000), dep("s1", "2026-06-12", 50_000, "savings"), dep("c2", "2026-06-12", 145_000, "brokerage"), dep("s2", "2026-06-12", 100_000, "hsa")];
    expect(ids(deposits)).toEqual([
      ["c1", "s1"],
      ["c2", "s2"],
    ]);
  });
});

describe("expandDeposit", () => {
  const deposit = { categoryId: "paycheck", amountCents: 245_000 };
  it("counts gross pay and each placed deduction, adding up to the deposit", () => {
    const parts = expandDeposit(deposit, {
      grossCents: 300_000,
      lines: [
        { amountCents: 40_000, categoryId: "taxes" },
        { amountCents: 10_000, categoryId: "insurance" },
        { amountCents: 5_000, categoryId: null },
      ],
    });
    expect(parts).toEqual([
      { categoryId: "paycheck", amountCents: 295_000 },
      { categoryId: "taxes", amountCents: -40_000 },
      { categoryId: "insurance", amountCents: -10_000 },
    ]);
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(245_000);
  });

  it("falls back to the deposit alone when the stub no longer matches it", () => {
    expect(expandDeposit(deposit, { grossCents: 300_000, lines: [{ amountCents: 1, categoryId: "taxes" }] })).toEqual([deposit]);
  });
});
