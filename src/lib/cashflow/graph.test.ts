import { describe, expect, it } from "vitest";
import { buildFlowGraph, type FlowGraph, type Paycheck } from "@/lib/cashflow/graph";
import { bandPath, layoutFlows } from "@/lib/cashflow/layout";
import type { CategoryInfo, Lookup, SpendLine } from "@/lib/spending/analyze";

// Invented employer, accounts, categories and merchants.

const cats: CategoryInfo[] = [
  { id: "food", name: "Food", kind: "expense", parentId: null },
  { id: "dining", name: "Dining", kind: "expense", parentId: "food" },
  { id: "groceries", name: "Groceries", kind: "expense", parentId: "food" },
  { id: "rent", name: "Rent", kind: "expense", parentId: null },
  { id: "interest", name: "Interest", kind: "income", parentId: null },
  { id: "card", name: "Credit Card Payment", kind: "transfer", parentId: null },
];
const lookup: Lookup = {
  categories: new Map(cats.map((c) => [c.id, c])),
  accountNames: new Map([
    ["checking", "Everyday Checking"],
    ["savings", "Rainy Day Savings"],
    ["visa", "Rewards Card"],
  ]),
};

// $3,500 gross: $400 federal, $217 Social Security, $50.75 Medicare, $200
// 401(k), $60.50 medical; $2,571.75 take-home, $500 of it to savings.
const paycheck: Paycheck = {
  employer: "Acme Widgets",
  grossCents: 350_000,
  lines: [
    { kind: "federal_income_tax", amountCents: 40_000 },
    { kind: "social_security", amountCents: 21_700 },
    { kind: "medicare", amountCents: 5_075 },
    { kind: "retirement_pretax", amountCents: 20_000 },
    { kind: "health_insurance", amountCents: 6_050 },
  ],
  employerLines: [
    { kind: "retirement_match", amountCents: 10_000 },
    { kind: "life_insurance", amountCents: 900 },
  ],
  deposits: [
    { accountId: "checking", amountCents: 207_175 },
    { accountId: "savings", amountCents: 50_000 },
  ],
};

let n = 0;
const line = (categoryId: string, cents: number, extra: Partial<SpendLine> = {}): SpendLine => ({
  transactionId: `t${++n}`,
  date: "2026-09-10",
  amountCents: cents,
  categoryId,
  accountId: "visa",
  merchant: "Lumen Bistro",
  ...extra,
});

const value = (g: FlowGraph, source: string, target: string) => g.links.find((l) => l.source === source && l.target === target)?.valueCents;

describe("buildFlowGraph", () => {
  const lines = [
    line("dining", -4_500),
    line("dining", -2_000),
    line("dining", 500), // a refund offsets
    line("groceries", -9_000, { merchant: "Quillfield Market" }),
    line("food", -1_200, { merchant: null }),
    line("rent", -185_000, { accountId: "checking", merchant: "Maplewood Rent" }),
    line("interest", 1_150, { accountId: "savings", merchant: null }),
  ];
  const transfers = [
    { fromAccountId: "checking", toAccountId: "visa", label: "Credit Card Payment", amountCents: 16_200, transactionId: "x1" },
    { fromAccountId: "savings", toAccountId: "checking", label: "Between Accounts", amountCents: 10_000, transactionId: "x2" },
    { fromAccountId: "checking", toAccountId: "savings", label: "Between Accounts", amountCents: 30_000, transactionId: "x3" },
    { fromAccountId: "checking", toAccountId: null, label: "Loan Payment", amountCents: 25_000, transactionId: "x4" },
  ];
  const graph = buildFlowGraph({ paychecks: [paycheck], lines, transfers, by: "category", lookup });

  it("runs gross pay through each tax and election to the accounts it was paid into", () => {
    const pay = "pay:Acme Widgets";
    expect(value(graph, pay, "tax:federal_income_tax")).toBe(40_000);
    expect(value(graph, pay, "tax:social_security")).toBe(21_700);
    expect(value(graph, pay, "tax:medicare")).toBe(5_075);
    expect(value(graph, pay, "saved:retirement")).toBe(20_000);
    expect(value(graph, pay, "deduction:health_insurance")).toBe(6_050);
    // Split across two accounts, in the amounts paid.
    expect(value(graph, pay, "account:checking")).toBe(207_175);
    expect(value(graph, pay, "account:savings")).toBe(50_000);
    // Everything out of gross adds back up to it.
    expect(graph.links.filter((l) => l.source === pay).reduce((s, l) => s + l.valueCents, 0)).toBe(350_000);
    expect(graph.nodes.find((x) => x.id === "saved:retirement")).toMatchObject({ label: "401(k)", role: "saved" });
  });

  it("shows the employer's 401(k) match as its own source, and leaves out what isn't money received", () => {
    expect(value(graph, "employer:Acme Widgets:retirement_match", "saved:retirement")).toBe(10_000);
    expect(graph.nodes.find((x) => x.id === "employer:Acme Widgets:retirement_match")!.role).toBe("income");
    expect(graph.nodes.some((x) => x.id.includes("life_insurance"))).toBe(false);
  });

  it("lands other income in its account, and spends from the account charged, net of refunds", () => {
    expect(value(graph, "income:interest", "account:savings")).toBe(1_150);
    expect(value(graph, "account:visa", "spend:food")).toBe(16_200);
    expect(value(graph, "spend:food", "spend:dining")).toBe(6_000);
    expect(value(graph, "spend:food", "spend:groceries")).toBe(9_000);
    // Spending on the parent itself stays there: no "not in a subcategory" branch.
    expect(graph.nodes.some((x) => x.id.endsWith(":self"))).toBe(false);
    expect(value(graph, "account:checking", "spend:rent")).toBe(185_000);
  });

  it("links transfers between accounts, netted, never as income or spending", () => {
    expect(value(graph, "account:checking", "account:visa")).toBe(16_200);
    // $300 to savings and $100 back: $200 to savings on balance.
    expect(value(graph, "account:checking", "account:savings")).toBe(20_000);
    expect(value(graph, "account:savings", "account:checking")).toBeUndefined();
    expect(graph.links.find((l) => l.source === "account:checking" && l.target === "account:savings")!.count).toBe(2);
    expect(value(graph, "account:checking", "transfer:Loan Payment")).toBe(25_000);
    expect(graph.nodes.some((x) => x.role === "spend" && /Card|Between/.test(x.label))).toBe(false);
  });

  it("counts the transactions behind each flow", () => {
    expect(graph.links.find((l) => l.source === "account:visa" && l.target === "spend:food")!.count).toBe(5);
    expect(graph.links.find((l) => l.source === "pay:Acme Widgets" && l.target === "account:checking")!.count).toBe(1);
  });

  it("groups spending by merchant or by account, as the Spending page does", () => {
    const byMerchant = buildFlowGraph({ paychecks: [], lines, transfers: [], by: "merchant", lookup });
    expect(value(byMerchant, "account:visa", "spend:Lumen Bistro")).toBe(6_000);
    expect(value(byMerchant, "account:visa", "spend:")).toBe(1_200);
    expect(byMerchant.nodes.find((x) => x.id === "spend:")!.label).toBe("No merchant");
    const byAccount = buildFlowGraph({ paychecks: [], lines, transfers: [], by: "account", lookup });
    expect(value(byAccount, "account:visa", "spend:all")).toBe(16_200);
    expect(value(byAccount, "account:checking", "spend:all")).toBe(185_000);
  });

  it("folds a long tail of merchants into one node", () => {
    const many = Array.from({ length: 15 }, (_, i) => line("dining", -(1_000 + i), { merchant: `Cafe ${String(i).padStart(2, "0")}` }));
    const g = buildFlowGraph({ paychecks: [], lines: many, transfers: [], by: "merchant", lookup });
    expect(g.nodes.filter((x) => x.role === "spend")).toHaveLength(13);
    expect(value(g, "account:visa", "spend:other-merchants")).toBe(1_000 + 1_001 + 1_002);
  });
});

describe("layoutFlows", () => {
  const graph = buildFlowGraph({
    paychecks: [paycheck],
    lines: [line("dining", -4_500), line("groceries", -9_000), line("rent", -185_000, { accountId: "checking" })],
    transfers: [{ fromAccountId: "checking", toAccountId: "visa", label: "Credit Card Payment", amountCents: 13_500, transactionId: "x" }],
    by: "category",
    lookup,
  });
  const layout = layoutFlows(graph, { width: 800 });
  const at = (id: string) => layout.nodes.find((x) => x.id === id)!;

  it("puts each node one column right of what feeds it", () => {
    expect(at("pay:Acme Widgets").column).toBe(0);
    expect(at("tax:federal_income_tax").column).toBe(1);
    expect(at("account:checking").column).toBe(1);
    // The card is paid from checking, so it sits after it, and its spending after that.
    expect(at("account:visa").column).toBe(2);
    expect(at("spend:food").column).toBe(3);
    expect(at("spend:dining").column).toBe(4);
    expect(layout.columns).toBe(5);
    expect(at("spend:dining").x).toBe(800 - layout.nodeWidth);
  });

  it("keeps an account out of the income column even when nothing flowed into it", () => {
    const g = buildFlowGraph({ paychecks: [paycheck], lines: [line("dining", -4_500)], transfers: [], by: "category", lookup });
    const l = layoutFlows(g, { width: 800 });
    expect(l.nodes.find((x) => x.id === "account:visa")!.column).toBe(1);
    expect(l.nodes.find((x) => x.id === "spend:food")!.column).toBe(2);
  });

  it("sizes nodes by what flows through them, on one scale", () => {
    const checking = at("account:checking");
    expect(checking.inCents).toBe(207_175);
    expect(checking.outCents).toBe(185_000 + 13_500);
    const food = at("spend:food");
    const visa = at("account:visa");
    expect(food.height / visa.height).toBeCloseTo(13_500 / 13_500, 5);
    expect(checking.height / food.height).toBeCloseTo(207_175 / 13_500, 5);
  });

  it("stacks bands without overlap at each end", () => {
    const fromPay = layout.links.filter((l) => l.source === "pay:Acme Widgets").sort((a, b) => a.sourceY - b.sourceY);
    for (let i = 1; i < fromPay.length; i++) {
      expect(fromPay[i].sourceY - fromPay[i].width / 2).toBeCloseTo(fromPay[i - 1].sourceY + fromPay[i - 1].width / 2, 5);
    }
    expect(bandPath(fromPay[0])).toMatch(/^M\d/);
  });
});
