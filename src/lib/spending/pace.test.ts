import { describe, expect, it } from "vitest";
import { flowDays } from "@/lib/cashflow/series";
import type { Lookup, SpendLine } from "./analyze";
import { monthPace, spendDays, yearPace } from "./pace";

// Made-up categories and lines.
const lookup: Lookup = {
  categories: new Map([
    ["food", { id: "food", name: "Food", kind: "expense", parentId: null }],
    ["pay", { id: "pay", name: "Pay", kind: "income", parentId: null }],
  ]),
  accountNames: new Map(),
};
const line = (date: string, amountCents: number, categoryId = "food"): SpendLine => ({ transactionId: `${date}${amountCents}`, date, amountCents, categoryId, accountId: "a", merchant: null });
const out = (from: string, to: string, spends: [string, number][]) => flowDays(from, to, [], spends.map(([date, cents]) => ({ date, cents })));

describe("spendDays", () => {
  it("counts expense lines only, with a refund against its day", () => {
    const days = spendDays([line("2026-03-02", -5000), line("2026-03-02", 1000), line("2026-03-03", 900000, "pay")], lookup, "2026-03-01", "2026-03-03");
    expect(days.map((d) => d.outCents)).toEqual([0, 4000, 0]);
  });
});

describe("monthPace", () => {
  const days = out("2026-03-01", "2026-03-04", [["2026-03-01", 1000], ["2026-03-03", 500]]);

  it("runs to today, the last point the total, with the typical drawn on past it", () => {
    const priors = [out("2026-02-01", "2026-02-03", [["2026-02-01", 600]]), out("2026-01-01", "2026-01-04", [["2026-01-02", 1200]])];
    const p = monthPace(days, priors, "2026-03-03");
    expect(p.map((x) => x.spentCents)).toEqual([1000, 1000, 1500, null]);
    // A shorter month holds its total for the days it doesn't have.
    expect(p.map((x) => x.typicalCents)).toEqual([300, 900, 900, 900]);
    expect(p[0].periods).toBe(2);
  });

  it("has no typical without the months before", () => {
    expect(monthPace(days, null, "2026-03-31").every((x) => x.typicalCents === null)).toBe(true);
  });
});

describe("yearPace", () => {
  const days = out("2026-01-01", "2026-12-31", [["2026-01-10", 1000], ["2026-02-10", 2000], ["2026-03-02", 400]]);

  it("adds up by month to today, against the typical months added up", () => {
    // 2025 had January to March whole; 2024 only January.
    const earlier = [
      ...out("2024-01-01", "2024-12-31", [["2024-01-05", 3000]]),
      ...out("2025-01-01", "2025-12-31", [["2025-01-05", 1000], ["2025-02-05", 500], ["2025-03-05", 100]]),
    ];
    const p = yearPace("2026", days, earlier, { firstDay: "2024-01-01", today: "2026-03-15" });
    expect(p.slice(0, 4).map((x) => x.spentCents)).toEqual([1000, 3000, 3400, null]);
    // January is 2024 and 2025 averaged; later months, 2025 and 2024's empty months, averaged too.
    expect(p.slice(0, 3).map((x) => x.typicalCents)).toEqual([2000, 2250, 2300]);
    expect(p[0].periods).toBe(2);
  });

  it("stops the typical at the first month no earlier year has", () => {
    const earlier = out("2025-06-01", "2025-12-31", [["2025-07-01", 100]]);
    const p = yearPace("2026", days, earlier, { firstDay: "2025-06-01", today: "2026-12-31" });
    expect(p.every((x) => x.typicalCents === null)).toBe(true);
  });
});
