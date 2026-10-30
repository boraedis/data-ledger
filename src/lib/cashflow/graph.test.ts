import { describe, expect, it } from "vitest";
import { buildFlowGraph, type AccountInfo, type FlowGraph, type FlowInput, type Paycheck, type Transfer } from "@/lib/cashflow/graph";
import { bandPath, layoutFlows } from "@/lib/cashflow/layout";
import type { CategoryInfo, Lookup, SpendLine } from "@/lib/spending/analyze";

// Invented employer, accounts, categories and merchants.

const cats: CategoryInfo[] = [
  { id: "food", name: "Food", kind: "expense", parentId: null },
  { id: "dining", name: "Dining", kind: "expense", parentId: "food" },
  { id: "groceries", name: "Groceries", kind: "expense", parentId: "food" },
  { id: "rent", name: "Rent", kind: "expense", parentId: null },
  { id: "interest", name: "Interest", kind: "income", parentId: null },
  { id: "cardpay", name: "Credit Card Payment", kind: "transfer", parentId: null },
];
const accounts = new Map<string, AccountInfo>([
  ["checking", { name: "Everyday Checking", group: "spending" }],
  ["savings", { name: "Rainy Day Savings", group: "savings" }],
  ["visa", { name: "Rewards Card", group: "debt" }],
  ["brokerage", { name: "Index Fund Account", group: "investment" }],
]);
const lookup: Lookup = { categories: new Map(cats.map((c) => [c.id, c])), accountNames: new Map([...accounts].map(([id, a]) => [id, a.name])) };

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
const transfer = (from: string | null, to: string | null, cents: number, label = "Transfer"): Transfer => ({ fromAccountId: from, toAccountId: to, label, amountCents: cents, transactionId: `x${++n}` });

const build = (input: Partial<FlowInput>) => buildFlowGraph({ paychecks: [], lines: [], uncategorized: [], transfers: [], accounts, by: "category", lookup, ...input });
const value = (g: FlowGraph, source: string, target: string) => g.links.find((l) => l.source === source && l.target === target)?.valueCents;
const into = (g: FlowGraph, target: string) => g.links.filter((l) => l.target === target).reduce((s, l) => s + l.valueCents, 0);
const outOf = (g: FlowGraph, source: string) => g.links.filter((l) => l.source === source).reduce((s, l) => s + l.valueCents, 0);
const level = (g: FlowGraph, id: string) => g.nodes.find((x) => x.id === id)?.level;

describe("buildFlowGraph: five levels", () => {
  // A month: pay, interest, card spending (part paid off), rent from
  // checking, $300 to the brokerage, the rest left in checking.
  const graph = build({
    paychecks: [paycheck],
    lines: [
      line("dining", -4_500),
      line("dining", -2_000),
      line("dining", 500), // a refund offsets
      line("groceries", -9_000, { merchant: "Quillfield Market" }),
      line("food", -1_200, { merchant: null }),
      line("rent", -185_000, { accountId: "checking", merchant: "Maplewood Rent" }),
      line("interest", 1_150, { accountId: "savings", merchant: null }),
    ],
    transfers: [transfer("checking", "visa", 10_000, "Credit Card Payment"), transfer("checking", "brokerage", 30_000)],
    uncategorized: [{ transactionId: "u1", accountId: "checking", amountCents: -2_500 }],
  });

  it("1 → 2: gross pay through each tax and election, and the rest into one take-home bucket", () => {
    const pay = "pay:Acme Widgets";
    expect(level(graph, pay)).toBe(1);
    expect(value(graph, pay, "tax:federal_income_tax")).toBe(40_000);
    expect(value(graph, pay, "election:401k")).toBe(20_000);
    expect(value(graph, pay, "deduction:health_insurance")).toBe(6_050);
    // The split deposit is one take-home, $2,071.75 + $500.
    expect(value(graph, pay, "pool:take-home")).toBe(257_175);
    expect(outOf(graph, pay)).toBe(350_000);
    expect([level(graph, "pool:take-home"), level(graph, "tax:federal_income_tax"), level(graph, "election:401k")]).toEqual([2, 2, 2]);
  });

  it("carries the 401(k), with the employer's match, on into Investing", () => {
    expect(value(graph, "employer:Acme Widgets:retirement_match", "election:401k")).toBe(10_000);
    expect(value(graph, "election:401k", "bucket:investing")).toBe(30_000);
    expect(value(graph, "bucket:investing", "invested:election:401k")).toBe(30_000);
    // Life insurance isn't money received.
    expect(graph.nodes.some((x) => x.id.includes("life_insurance"))).toBe(false);
  });

  it("2 → 3 → 4 → 5: spending into categories and subcategories, card spending counted when charged", () => {
    expect(value(graph, "pool:take-home", "bucket:spending")).toBe(16_200 + 185_000 + 2_500);
    expect(value(graph, "bucket:spending", "spend:category:food")).toBe(16_200);
    expect(value(graph, "spend:category:food", "spend:dining")).toBe(6_000);
    expect(value(graph, "spend:category:food", "spend:groceries")).toBe(9_000);
    expect(value(graph, "bucket:spending", "spend:uncategorized")).toBe(2_500);
    expect([level(graph, "bucket:spending"), level(graph, "spend:category:food"), level(graph, "spend:dining")]).toEqual([3, 4, 5]);
  });

  it("nets each account into saved, invested, paid down or drawn on, never as income or spending", () => {
    // Savings: the $500 deposit plus $11.50 interest.
    expect(value(graph, "bucket:savings", "account:savings")).toBe(51_150);
    // The brokerage got $300; the card was charged $162 and paid $100, so $62 went on credit.
    expect(value(graph, "bucket:investing", "account:brokerage")).toBe(30_000);
    expect(value(graph, "draw:visa", "pool:take-home")).toBe(6_200);
    expect(graph.nodes.find((x) => x.id === "draw:visa")).toMatchObject({ label: "Put on Rewards Card", level: 1 });
    // Checking: $2,071.75 in; $1,850 rent, $25 uncategorized, $100 to the card and $300 to the brokerage out: $203.25 short.
    expect(value(graph, "draw:checking", "pool:take-home")).toBe(20_325);
    expect(graph.nodes.find((x) => x.id === "draw:checking")!.label).toBe("From Everyday Checking (cash on hand)");
    expect(graph.nodes.some((x) => /Credit Card Payment/.test(x.label))).toBe(false);
  });

  it("adds up: what flows into take-home is exactly what flows out of it", () => {
    expect(into(graph, "pool:take-home")).toBe(outOf(graph, "pool:take-home"));
    for (const b of ["bucket:spending", "bucket:investing", "bucket:savings"]) expect(outOf(graph, b)).toBe(into(graph, b));
  });

  it("counts the transactions behind each flow", () => {
    expect(graph.links.find((l) => l.source === "bucket:spending" && l.target === "spend:category:food")!.count).toBe(5);
    expect(graph.links.find((l) => l.source === "pay:Acme Widgets" && l.target === "pool:take-home")!.count).toBe(1);
  });
});

describe("buildFlowGraph: other cases", () => {
  it("shows money moved out of investments as a source, and what stayed in checking as saved", () => {
    const g = build({
      lines: [line("rent", -100_000, { accountId: "checking" })],
      transfers: [transfer("brokerage", "checking", 150_000)],
    });
    expect(value(g, "draw:brokerage", "pool:take-home")).toBe(150_000);
    expect(g.nodes.find((x) => x.id === "draw:brokerage")!.label).toBe("From Index Fund Account");
    expect(value(g, "bucket:savings", "account:checking")).toBe(50_000);
    expect(g.nodes.find((x) => x.id === "account:checking")!.label).toBe("Kept in Everyday Checking");
  });

  it("shows paying a card down beyond the month's charges as debt paydown", () => {
    const g = build({ paychecks: [paycheck], lines: [line("dining", -5_000)], transfers: [transfer("checking", "visa", 25_000)] });
    expect(value(g, "bucket:debt", "account:visa")).toBe(20_000);
  });

  it("keeps a transfer missing its other half out of income and spending", () => {
    const g = build({ paychecks: [paycheck], transfers: [transfer("checking", null, 40_000, "Loan Payment"), transfer(null, "checking", 5_000, "Between Accounts")] });
    expect(value(g, "bucket:other", "other:Loan Payment")).toBe(40_000);
    expect(value(g, "draw:in:Between Accounts", "pool:take-home")).toBe(5_000);
    expect(into(g, "pool:take-home")).toBe(outOf(g, "pool:take-home"));
  });

  it("turns uncategorized money in into a source, and a refund-only category into one too", () => {
    const g = build({ uncategorized: [{ transactionId: "u", accountId: "checking", amountCents: 4_000 }], lines: [line("rent", 2_000, { accountId: "checking" })] });
    expect(value(g, "income:uncategorized", "pool:take-home")).toBe(4_000);
    expect(value(g, "draw:refund:category:rent", "pool:take-home")).toBe(2_000);
    expect(into(g, "pool:take-home")).toBe(outOf(g, "pool:take-home"));
  });

  it("breaks spending down by merchant on request, folding a long tail", () => {
    const many = Array.from({ length: 15 }, (_, i) => line("dining", -(1_000 + i), { merchant: `Cafe ${String(i).padStart(2, "0")}` }));
    const g = build({ lines: many, by: "merchant" });
    expect(g.nodes.filter((x) => x.level === 4 && x.role === "spend")).toHaveLength(13);
    expect(value(g, "bucket:spending", "spend:merchant:other")).toBe(1_000 + 1_001 + 1_002);
  });
});

describe("layoutFlows", () => {
  const graph = build({ paychecks: [paycheck], lines: [line("dining", -4_500), line("groceries", -9_000), line("rent", -185_000, { accountId: "checking" })], transfers: [transfer("checking", "visa", 13_500)] });
  const layout = layoutFlows(graph, { width: 800 });
  const at = (id: string) => layout.nodes.find((x) => x.id === id)!;

  it("puts each level in its own column, closing up empty ones", () => {
    expect([at("pay:Acme Widgets").column, at("pool:take-home").column, at("bucket:spending").column, at("spend:category:food").column, at("spend:dining").column]).toEqual([0, 1, 2, 3, 4]);
    expect(layoutFlows(build({ lines: [line("rent", -1_000, { accountId: "checking" })] }), { width: 800 }).columns).toBe(4);
    expect(at("spend:dining").x).toBe(800 - layout.nodeWidth);
  });

  it("keeps each bucket's breakdown beside it, largest first", () => {
    const spendChildren = layout.nodes.filter((x) => x.column === 3 && x.role === "spend").sort((a, b) => a.y - b.y);
    expect(spendChildren.map((x) => x.label)).toEqual(["Rent", "Food"]);
    const g = build({ lines: [line("rent", -50_000, { accountId: "checking" }), line("dining", -100), line("groceries", -9_000), line("interest", 80_000, { accountId: "checking" })], transfers: [transfer("checking", "brokerage", 20_000)] });
    const l = layoutFlows(g, { width: 800 });
    const y = (id: string) => l.nodes.find((x) => x.id === id)!.y;
    // Spending's categories, then what's kept and invested: never interleaved.
    const spending = ["spend:category:rent", "spend:category:food"].map(y);
    const others = ["account:brokerage", "account:checking"].filter((id) => l.nodes.some((x) => x.id === id)).map(y);
    expect(Math.max(...spending) < Math.min(...others) || Math.min(...spending) > Math.max(...others)).toBe(true);
  });

  it("sizes nodes by what flows through them, on one scale", () => {
    const pool = at("pool:take-home");
    const spending = at("bucket:spending");
    expect(pool.inCents).toBe(pool.outCents);
    expect(pool.height / spending.height).toBeCloseTo(pool.inCents / spending.inCents, 5);
  });

  it("stacks bands without overlap at each end", () => {
    const fromPay = layout.links.filter((l) => l.source === "pay:Acme Widgets").sort((a, b) => a.sourceY - b.sourceY);
    for (let i = 1; i < fromPay.length; i++) {
      expect(fromPay[i].sourceY - fromPay[i].width / 2).toBeCloseTo(fromPay[i - 1].sourceY + fromPay[i - 1].width / 2, 5);
    }
    expect(bandPath(fromPay[0])).toMatch(/^M\d/);
  });
});
