import { describe, expect, it } from "vitest";
import { distribute, normalizeName, personInText, proposeAllocations } from "@/lib/reimbursements/match";

// Invented people and payments.

const people = [
  { id: "alex", name: "Alex Rivera", aliases: ["A RIVERA"] },
  { id: "sam", name: "Sam Okafor", aliases: [] },
  { id: "sam2", name: "Sam", aliases: [] },
  { id: "jo", name: "Jo Lee", aliases: [] },
  { id: "jo2", name: "Jo Lee", aliases: [] },
];

describe("personInText", () => {
  it("finds a person by name or alias as whole words", () => {
    expect(normalizeName("Payment from alex.rivera!")).toBe("PAYMENT FROM ALEX RIVERA");
    expect(personInText(people, "PAYPEER PAYMENT FROM ALEX RIVERA")).toBe("alex");
    expect(personInText(people, "Zelle from A. Rivera")).toBe("alex");
    expect(personInText(people, "PAYMENT FROM ALEXANDRA RIVERAS")).toBeNull();
  });

  it("prefers the longer name, and gives up on an exact tie", () => {
    expect(personInText(people, "CASH APP SAM OKAFOR")).toBe("sam");
    expect(personInText(people, "CASH APP SAM")).toBe("sam2");
    expect(personInText(people, "VENMO FROM JO LEE")).toBeNull();
  });
});

describe("proposeAllocations", () => {
  const item = (id: string, date: string, dollars: number) => ({ id, date, remainingCents: dollars * 100 });
  const pay = (date: string, dollars: number) => ({ date, remainingCents: dollars * 100 });

  it("matches one reimbursement for the same amount, closest in time", () => {
    expect(proposeAllocations(pay("2026-06-10", 45), [item("a", "2026-05-01", 45), item("b", "2026-06-08", 45), item("c", "2026-06-08", 30)])).toEqual({
      kind: "exact",
      allocations: [{ reimbursementId: "b", amountCents: 4_500 }],
    });
  });

  it("combines several reimbursements one payment covers", () => {
    expect(proposeAllocations(pay("2026-06-20", 75), [item("a", "2026-06-01", 30), item("b", "2026-06-12", 45), item("c", "2026-06-15", 20)])).toEqual({
      kind: "combined",
      allocations: [
        { reimbursementId: "a", amountCents: 3_000 },
        { reimbursementId: "b", amountCents: 4_500 },
      ],
    });
  });

  it("applies a partial payment oldest first, and a larger one to everything open", () => {
    expect(proposeAllocations(pay("2026-06-20", 50), [item("a", "2026-06-01", 30), item("b", "2026-06-12", 45)])).toEqual({
      kind: "partial",
      allocations: [
        { reimbursementId: "a", amountCents: 3_000 },
        { reimbursementId: "b", amountCents: 2_000 },
      ],
    });
    expect(proposeAllocations(pay("2026-06-20", 100), [item("a", "2026-06-01", 30), item("b", "2026-06-12", 45)])?.kind).toBe("more");
  });

  it("can be limited to exact and combined matches, the strong evidence", () => {
    const items = [item("a", "2026-06-01", 30), item("b", "2026-06-12", 45)];
    expect(proposeAllocations(pay("2026-06-20", 50), items, { exactOnly: true })).toBeNull();
    expect(proposeAllocations(pay("2026-06-20", 45), items, { exactOnly: true })?.kind).toBe("exact");
  });

  it("ignores reimbursements far in the past or well after the payment", () => {
    expect(proposeAllocations(pay("2026-06-20", 45), [item("a", "2026-01-01", 45), item("b", "2026-06-30", 45)])).toBeNull();
    // A few days early is fine: someone paying ahead.
    expect(proposeAllocations(pay("2026-06-20", 45), [item("b", "2026-06-22", 45)])?.kind).toBe("exact");
  });
});

describe("distribute", () => {
  it("splits in proportion, in whole cents that add up", () => {
    expect(distribute(1_000, [-3_000, -1_000])).toEqual([750, 250]);
    expect(distribute(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(distribute(0, [5, 5])).toEqual([0, 0]);
  });
});
