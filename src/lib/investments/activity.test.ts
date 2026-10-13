import { describe, expect, it } from "vitest";
import { investmentActivity, isInvestmentIncome } from "@/lib/investments/activity";

// Descriptions invented, in the shapes brokerages tend to use.

describe("investmentActivity", () => {
  it.each([
    ["DIVIDEND RECEIVED EXTM", "dividend"],
    ["QUALIFIED DIV EXIN", "dividend"],
    ["LONG TERM CAP GAIN EXTM", "dividend"],
    ["DIVIDEND REINVESTMENT EXTM", "reinvestment"],
    ["REINVEST SHARES EXBD", "reinvestment"],
    ["INTEREST ON CASH SWEEP", "interest"],
    ["BANK INT 0.01%", "interest"],
    ["BUY EXTM EXAMPLE TOTAL MARKET", "buy"],
    ["YOU BOUGHT EXIN", "buy"],
    ["SOLD 10 EXBD", "sell"],
    ["REDEMPTION EXAMPLE MONEY FUND", "sell"],
    ["COMMISSION", "fee"],
    ["ADVISORY FEE Q3", "fee"],
    ["ACH DEPOSIT FROM BANK", "transfer"],
    ["EMPLOYEE CONTRIBUTION", "transfer"],
    ["ROLLOVER FROM PRIOR PLAN", "transfer"],
    ["DISTRIBUTION", "transfer"],
    ["JOURNAL ENTRY", "transfer"],
    ["CORPORATE ACTION XYZ", "other"],
  ])("%s → %s", (description, activity) => {
    expect(investmentActivity(description)).toBe(activity);
  });

  it("counts only money in from dividends and interest as income", () => {
    expect(isInvestmentIncome("dividend", 1_000)).toBe(true);
    expect(isInvestmentIncome("interest", 25)).toBe(true);
    expect(isInvestmentIncome("dividend", -1_000)).toBe(false);
    expect(isInvestmentIncome("sell", 50_000)).toBe(false);
    expect(isInvestmentIncome("transfer", 50_000)).toBe(false);
  });
});
