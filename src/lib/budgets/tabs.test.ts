import { describe, expect, it } from "vitest";
import { BUDGET_TABS, budgetHref, budgetView } from "@/lib/budgets/tabs";

const TODAY = "2026-10-15";
const yearTab = BUDGET_TABS.find((t) => t.id === "year")!;

describe("budget tabs (#145)", () => {
  it("opens the Year view ending in March, still gross, from March's Month view", () => {
    const view = budgetView({ month: "2026-03", gross: "1" }, TODAY);
    expect(budgetHref(yearTab.path, view)).toBe("/budgets/year?month=2026-03&gross=1");
  });

  it("keeps this month and net out of the URL", () => {
    const view = budgetView({}, TODAY);
    expect(BUDGET_TABS.map((t) => budgetHref(t.path, view))).toEqual(["/budgets/dashboard", "/budgets", "/budgets/year", "/budgets/targets"]);
  });

  it("never carries a month later than this one, or a malformed one", () => {
    expect(budgetView({ month: "2027-01" }, TODAY).month).toBe("2026-10");
    expect(budgetView({ month: "March" }, TODAY).month).toBe("2026-10");
    expect(budgetView({ gross: "yes" }, TODAY).gross).toBe(false);
  });
});
