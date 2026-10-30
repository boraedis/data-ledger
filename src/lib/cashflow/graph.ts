import type { EmployerPayKind, PayLineKind } from "@/lib/pay/stubs";
import { kindLabel } from "@/lib/pay/stubs";
import { keysFor, type Lookup, type SpendLine } from "@/lib/spending/analyze";

// Cash flow (#62): a period's money as a Sankey in five levels, left to right.
//
//   1. Where it came from: each employer's gross pay, the employer's own
//      401(k) and HSA contributions, other income, and what the period drew
//      on (savings, investments sold to cash, card balances that grew, cash
//      on hand), so nothing is unexplained
//   2. Take-home, one bucket, beside what came off the paycheck first:
//      each tax, the 401(k) and HSA, insurance and other deductions
//   3. Where it went: Spending, Investing, Cash savings, Debt paydown
//   4. The breakdown: spending categories (or merchants), each investment
//      and savings account (with what stayed in checking), each card or loan
//   5. Subcategories under their spending category
//
// Accounts never appear as pass-through nodes. Each account's net movement
// over the period lands on one side: a positive net is an allocation
// (saved, invested, paid down, kept), a negative one a source (drawn from
// savings, put on a card). That's what makes every level add up to the one
// before it, by construction: income and draws in, allocations out.
//
// Widths are integer cents. The graph holds labels and totals only: no
// balances, holdings or transaction descriptions.

export type Role = "income" | "draw" | "pool" | "tax" | "saved" | "spend" | "debt";
export type FlowNode = { id: string; label: string; role: Role; level: number };
export type FlowLink = { source: string; target: string; valueCents: number; count: number };
export type FlowGraph = { nodes: FlowNode[]; links: FlowLink[] };

// How an account's net movement reads: kept in a spending account, saved,
// invested, or a loan paid down (or, the other way, drawn on). A credit
// card is spending money, not debt to pay down: its charges are spending
// when they happen, and paying it from checking just settles them.
export type AccountGroup = "spending" | "card" | "savings" | "investment" | "debt";
export type AccountInfo = { name: string; group: AccountGroup };

export type Paycheck = {
  employer: string;
  grossCents: number;
  lines: { kind: PayLineKind; amountCents: number }[];
  employerLines: { kind: EmployerPayKind; amountCents: number }[];
  deposits: { accountId: string; amountCents: number }[];
};

// Money moved between the owner's accounts. A side that couldn't be found
// is null: money that left (or arrived) under a transfer category without
// its other half.
export type Transfer = { fromAccountId: string | null; toAccountId: string | null; label: string; amountCents: number; transactionId: string };

export type FlowInput = {
  paychecks: Paycheck[];
  // transactions.spendingLines for the period, less the stub-linked
  // deposits (the paychecks stand for those). Income and expense lines are
  // used; transfer-category lines are the transfers' business.
  lines: SpendLine[];
  // Money in or out with no category yet, not part of any transfer:
  // counted, so the diagram balances, as "Uncategorized".
  uncategorized: { transactionId: string; accountId: string; amountCents: number }[];
  transfers: Transfer[];
  accounts: Map<string, AccountInfo>;
  by: "category" | "merchant";
  lookup: Lookup;
};

const POOL = "pool:take-home";
const BUCKET = {
  spending: { id: "bucket:spending", label: "Spending", role: "spend" as const },
  investing: { id: "bucket:investing", label: "Investing", role: "saved" as const },
  savings: { id: "bucket:savings", label: "Cash savings", role: "saved" as const },
  debt: { id: "bucket:debt", label: "Debt paydown", role: "debt" as const },
  other: { id: "bucket:other", label: "Other transfers out", role: "debt" as const },
};

// Payroll money that's invested: off the paycheck at level 2, then on into
// Investing (#62: "total invested" includes it, and the employer's match).
const ELECTION: Partial<Record<PayLineKind, { id: string; label: string }>> = {
  retirement_pretax: { id: "election:401k", label: "401(k)" },
  retirement_roth: { id: "election:401k", label: "401(k)" },
  hsa: { id: "election:hsa", label: "HSA" },
};
const EMPLOYER: Partial<Record<EmployerPayKind, { id: string; label: string; source: string }>> = {
  retirement_match: { id: "election:401k", label: "401(k)", source: "401(k) match" },
  hsa: { id: "election:hsa", label: "HSA", source: "HSA contribution" },
};
const TAXES: PayLineKind[] = ["federal_income_tax", "state_income_tax", "local_income_tax", "social_security", "medicare", "state_disability"];

export const MAX_MERCHANTS = 12;

export function buildFlowGraph({ paychecks, lines, uncategorized, transfers, accounts, by, lookup }: FlowInput): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, FlowLink & { ids: Set<string> }>();
  const node = (id: string, label: string, role: Role, level: number) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, role, level });
    return id;
  };
  const flow = (source: string, target: string, cents: number, ids: Iterable<string>) => {
    if (cents <= 0) return;
    const key = `${source}→${target}`;
    const link = links.get(key) ?? { source, target, valueCents: 0, count: 0, ids: new Set<string>() };
    link.valueCents += cents;
    for (const id of ids) link.ids.add(id);
    links.set(key, link);
  };
  const pool = () => node(POOL, "Take-home", "pool", 2);
  const bucket = (b: (typeof BUCKET)[keyof typeof BUCKET]) => node(b.id, b.label, b.role, 3);
  const accountName = (id: string) => accounts.get(id)?.name ?? lookup.accountNames.get(id) ?? "Unknown account";

  // Each account's net movement, and the transactions behind it. Checking,
  // payment apps and credit cards are one pool of spending money: a card
  // payment from checking moves money inside it and cancels out, so it's
  // never counted on top of the charges it pays for (already spending, in
  // the month they were made).
  const SPENDING_MONEY = "spending-money";
  const keyOf = (accountId: string) => {
    const group = accounts.get(accountId)?.group;
    return group === "spending" || group === "card" ? SPENDING_MONEY : accountId;
  };
  const spendingNames = [...accounts.values()].filter((a) => a.group === "spending").map((a) => a.name);
  const spendingMoney = spendingNames.length === 1 ? spendingNames[0] : "checking";
  const net = new Map<string, { cents: number; ids: Set<string> }>();
  const move = (accountId: string | null, cents: number, id: string) => {
    if (!accountId) return;
    const key = keyOf(accountId);
    const n = net.get(key) ?? { cents: 0, ids: new Set<string>() };
    n.cents += cents;
    n.ids.add(id);
    net.set(key, n);
  };

  // 1 → 2: pay, gross, through what comes off it to take-home.
  paychecks.forEach((p, i) => {
    const id = [`stub${i}`];
    const pay = node(`pay:${p.employer}`, `${p.employer} pay`, "income", 1);
    for (const line of p.lines) {
      const election = ELECTION[line.kind];
      const target = election
        ? node(election.id, election.label, "saved", 2)
        : TAXES.includes(line.kind)
          ? node(`tax:${line.kind}`, kindLabel(line.kind), "tax", 2)
          : node(`deduction:${line.kind}`, kindLabel(line.kind), "spend", 2);
      flow(pay, target, line.amountCents, id);
    }
    for (const d of p.deposits) {
      flow(pay, pool(), d.amountCents, id);
      move(d.accountId, d.amountCents, id[0]);
    }
    for (const e of p.employerLines) {
      const dest = EMPLOYER[e.kind];
      // Life insurance and imputed income aren't money received.
      if (dest) flow(node(`employer:${p.employer}:${e.kind}`, `${p.employer} ${dest.source}`, "income", 1), node(dest.id, dest.label, "saved", 2), e.amountCents, id);
    }
  });

  // Other income by category; spending by group (and subcategory).
  const income = new Map<string, { label: string; cents: number; ids: Set<string> }>();
  const groups = new Map<string, { label: string; cents: number; ids: Set<string>; children: Map<string, { label: string; cents: number; ids: Set<string> }> }>();
  const merchantTotals = new Map<string, number>();
  if (by === "merchant") {
    for (const l of lines) if (lookup.categories.get(l.categoryId)?.kind === "expense") merchantTotals.set(l.merchant ?? "", (merchantTotals.get(l.merchant ?? "") ?? 0) - l.amountCents);
  }
  const top = new Set([...merchantTotals].sort((a, b) => b[1] - a[1]).slice(0, MAX_MERCHANTS).map(([m]) => m));
  const spend = (key: string, label: string, cents: number, id: string, child?: { key: string; label: string }) => {
    const g = groups.get(key) ?? { label, cents: 0, ids: new Set<string>(), children: new Map() };
    g.cents += cents;
    g.ids.add(id);
    if (child) {
      const c = g.children.get(child.key) ?? { label: child.label, cents: 0, ids: new Set<string>() };
      c.cents += cents;
      c.ids.add(id);
      g.children.set(child.key, c);
    }
    groups.set(key, g);
  };
  for (const l of lines) {
    const category = lookup.categories.get(l.categoryId);
    if (category?.kind === "income") {
      const inc = income.get(l.categoryId) ?? { label: category.name, cents: 0, ids: new Set<string>() };
      inc.cents += l.amountCents;
      inc.ids.add(l.transactionId);
      income.set(l.categoryId, inc);
      move(l.accountId, l.amountCents, l.transactionId);
    } else if (category?.kind === "expense") {
      move(l.accountId, l.amountCents, l.transactionId);
      if (by === "merchant") {
        const m = l.merchant ?? "";
        if (top.has(m)) spend(`merchant:${m}`, l.merchant ?? "No merchant", -l.amountCents, l.transactionId);
        else spend("merchant:other", "Other merchants", -l.amountCents, l.transactionId);
      } else {
        const k = keysFor(l, "category", lookup);
        spend(`category:${k.key}`, k.label, -l.amountCents, l.transactionId, k.child && !k.child.key.endsWith(":self") ? k.child : undefined);
      }
    }
  }
  let uncategorizedIn = { cents: 0, ids: new Set<string>() };
  for (const u of uncategorized) {
    move(u.accountId, u.amountCents, u.transactionId);
    if (u.amountCents < 0) spend("uncategorized", "Uncategorized", -u.amountCents, u.transactionId);
    else uncategorizedIn = { cents: uncategorizedIn.cents + u.amountCents, ids: uncategorizedIn.ids.add(u.transactionId) };
  }

  // Transfers move money between accounts: they shift nets, never income or
  // spending. A missing side is its own flow, in or out.
  const otherIn = new Map<string, { cents: number; ids: Set<string> }>();
  const otherOut = new Map<string, { cents: number; ids: Set<string> }>();
  for (const t of transfers) {
    move(t.fromAccountId, -t.amountCents, t.transactionId);
    move(t.toAccountId, t.amountCents, t.transactionId);
    const unmatched = t.fromAccountId === null ? otherIn : t.toAccountId === null ? otherOut : null;
    if (unmatched) {
      const u = unmatched.get(t.label) ?? { cents: 0, ids: new Set<string>() };
      u.cents += t.amountCents;
      u.ids.add(t.transactionId);
      unmatched.set(t.label, u);
    }
  }

  // Level 1 income into take-home.
  for (const [categoryId, inc] of income) {
    if (inc.cents > 0) flow(node(`income:${categoryId}`, inc.label, "income", 1), pool(), inc.cents, inc.ids);
    // Income that netted negative (a reversal) left the take-home: out it goes.
    else if (inc.cents < 0) spend(`reversed:${categoryId}`, `Returned: ${inc.label}`, -inc.cents, [...inc.ids][0]);
  }
  if (uncategorizedIn.cents > 0) flow(node("income:uncategorized", "Uncategorized money in", "income", 1), pool(), uncategorizedIn.cents, uncategorizedIn.ids);
  for (const [label, u] of otherIn) flow(node(`draw:in:${label}`, `${label} (other side not found)`, "draw", 1), pool(), u.cents, u.ids);

  // 2 → 3 → 4(→ 5): spending. A group refunded more than it spent is money
  // back: a source, so the totals still add up.
  for (const [key, g] of groups) {
    if (g.cents > 0) {
      const target = node(`spend:${key}`, g.label, "spend", 4);
      flow(pool(), bucket(BUCKET.spending), g.cents, g.ids);
      flow(bucket(BUCKET.spending), target, g.cents, g.ids);
      for (const [childKey, c] of g.children) flow(target, node(`spend:${childKey}`, c.label, "spend", 5), c.cents, c.ids);
    } else if (g.cents < 0) {
      flow(node(`draw:refund:${key}`, `Refunds: ${g.label}`, "draw", 1), pool(), -g.cents, g.ids);
    }
  }

  // Payroll elections and the employer's contributions, on into Investing.
  for (const e of [
    { id: "election:401k", label: "401(k) through payroll" },
    { id: "election:hsa", label: "HSA through payroll" },
  ]) {
    const into = [...links.values()].filter((l) => l.target === e.id);
    const cents = into.reduce((s, l) => s + l.valueCents, 0);
    const ids = into.flatMap((l) => [...l.ids]);
    flow(e.id, bucket(BUCKET.investing), cents, ids);
    flow(bucket(BUCKET.investing), node(`invested:${e.id}`, e.label, "saved", 4), cents, ids);
  }

  // Each account's net: an allocation when it grew, a source when drawn on.
  for (const [accountId, n] of net) {
    const info = accountId === SPENDING_MONEY ? ({ name: spendingMoney, group: "spending" } as const) : accounts.get(accountId);
    if (!info || n.cents === 0) continue;
    const name = accountId === SPENDING_MONEY ? spendingMoney : accountName(accountId);
    if (n.cents > 0) {
      const [b, label] =
        info.group === "investment"
          ? [BUCKET.investing, name]
          : info.group === "debt"
            ? [BUCKET.debt, name]
            : info.group === "savings"
              ? [BUCKET.savings, name]
              : [BUCKET.savings, `Kept in ${name}`];
      flow(pool(), bucket(b), n.cents, n.ids);
      flow(bucket(b), node(`account:${accountId}`, label, b.role, 4), n.cents, n.ids);
    } else {
      // Spending money that ran down: cash on hand, or charges not yet paid.
      const label = info.group === "spending" ? `From ${name} (cash on hand)` : `From ${name}`;
      flow(node(`draw:${accountId}`, label, "draw", 1), pool(), -n.cents, n.ids);
    }
  }
  for (const [label, u] of otherOut) {
    flow(pool(), bucket(BUCKET.other), u.cents, u.ids);
    flow(bucket(BUCKET.other), node(`other:${label}`, label, "debt", 4), u.cents, u.ids);
  }

  const kept = [...links.values()].map(({ ids, ...l }) => ({ ...l, count: ids.size }));
  const used = new Set(kept.flatMap((l) => [l.source, l.target]));
  return { nodes: [...nodes.values()].filter((n) => used.has(n.id)), links: kept };
}
