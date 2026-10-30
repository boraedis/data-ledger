import type { EmployerPayKind, PayLineKind } from "@/lib/pay/stubs";
import { kindLabel } from "@/lib/pay/stubs";
import { keysFor, type Grouping, type Lookup, type SpendLine } from "@/lib/spending/analyze";

// Cash flow (#62): where a period's money came from and where it went, as a
// Sankey graph. Pure, so every flow is tested; the page gathers the inputs
// (src/lib/cashflow/data.ts) from the same records Budgets and Spending use.
//
// The flow:
//   gross pay (per employer) → taxes, elections, deductions → the accounts
//     the take-home was deposited to, in the amounts paid
//   employer contributions (401(k) match, HSA) → their destination
//   other income (by category) → the account it landed in
//   account → account: transfers, never income or spending
//   account → spending, grouped as on the Spending page (a category's
//     subcategories branch off it)
//
// Widths are integer cents. The graph carries labels and totals only: no
// balances, holdings or transaction descriptions.

export type Role = "income" | "tax" | "saved" | "spend" | "account" | "transfer";
export type FlowNode = { id: string; label: string; role: Role };
export type FlowLink = { source: string; target: string; valueCents: number; count: number };
export type FlowGraph = { nodes: FlowNode[]; links: FlowLink[] };

export type Paycheck = {
  employer: string;
  grossCents: number;
  lines: { kind: PayLineKind; amountCents: number }[];
  employerLines: { kind: EmployerPayKind; amountCents: number }[];
  // Where the take-home went: one deposit, or several when pay is split.
  deposits: { accountId: string; amountCents: number }[];
};

// A transfer between the owner's accounts, outflow side first. Without the
// other side found, it ends at a node named for its category.
export type Transfer = { fromAccountId: string; toAccountId: string | null; label: string; amountCents: number; transactionId: string };

export type FlowInput = {
  paychecks: Paycheck[];
  // Spending lines for the period (transactions.spendingLines), without the
  // stub-linked deposits, which the paychecks stand for.
  lines: SpendLine[];
  transfers: Transfer[];
  by: Grouping;
  lookup: Lookup;
};

// Where an election goes: a destination of its own, savings or retirement.
const ELECTION: Partial<Record<PayLineKind, { id: string; label: string }>> = {
  retirement_pretax: { id: "saved:retirement", label: "401(k)" },
  retirement_roth: { id: "saved:retirement", label: "401(k)" },
  hsa: { id: "saved:hsa", label: "HSA" },
  fsa: { id: "saved:fsa", label: "FSA" },
};
const TAXES: PayLineKind[] = ["federal_income_tax", "state_income_tax", "local_income_tax", "social_security", "medicare", "state_disability"];
const EMPLOYER_DESTINATION: Partial<Record<EmployerPayKind, { id: string; label: string; source: string }>> = {
  retirement_match: { id: "saved:retirement", label: "401(k)", source: "401(k) match" },
  hsa: { id: "saved:hsa", label: "HSA", source: "HSA contribution" },
};

// A long tail of merchants folds into one node: the diagram stays legible,
// and the table under it still lists every flow.
export const MAX_MERCHANTS = 12;

export function buildFlowGraph({ paychecks, lines, transfers, by, lookup }: FlowInput): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, FlowLink & { ids: Set<string> }>();
  const node = (id: string, label: string, role: Role) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, role });
    return id;
  };
  const flow = (source: string, target: string, cents: number, ids: Iterable<string>) => {
    const key = `${source}→${target}`;
    const link = links.get(key) ?? { source, target, valueCents: 0, count: 0, ids: new Set<string>() };
    link.valueCents += cents;
    for (const id of ids) link.ids.add(id);
    links.set(key, link);
  };
  const account = (id: string) => node(`account:${id}`, lookup.accountNames.get(id) ?? "Unknown account", "account");

  // Paychecks: gross pay through each deduction to the deposits.
  paychecks.forEach((p, i) => {
    const pay = node(`pay:${p.employer}`, `${p.employer} pay`, "income");
    const id = [`stub${i}`];
    for (const line of p.lines) {
      const election = ELECTION[line.kind];
      const target = election
        ? node(election.id, election.label, "saved")
        : TAXES.includes(line.kind)
          ? node(`tax:${line.kind}`, kindLabel(line.kind), "tax")
          : node(`deduction:${line.kind}`, kindLabel(line.kind), "spend");
      flow(pay, target, line.amountCents, id);
    }
    for (const d of p.deposits) flow(pay, account(d.accountId), d.amountCents, id);
    for (const e of p.employerLines) {
      const dest = EMPLOYER_DESTINATION[e.kind];
      if (!dest) continue; // life insurance, imputed income: not money received
      flow(node(`employer:${p.employer}:${e.kind}`, `${p.employer} ${dest.source}`, "income"), node(dest.id, dest.label, "saved"), e.amountCents, id);
    }
  });

  // Other income, into the account it landed in; spending, out of the
  // account it was charged to. Netted per pair, so a refund offsets.
  const merchantTotals = new Map<string, number>();
  if (by === "merchant") {
    for (const l of lines) {
      if (lookup.categories.get(l.categoryId)?.kind !== "expense") continue;
      const m = l.merchant ?? "";
      merchantTotals.set(m, (merchantTotals.get(m) ?? 0) - l.amountCents);
    }
  }
  const topMerchants = new Set([...merchantTotals].sort((a, b) => b[1] - a[1]).slice(0, MAX_MERCHANTS).map(([m]) => m));
  const pending = new Map<string, { source: string; target: string; cents: number; ids: Set<string> }>();
  const add = (source: string, target: string, cents: number, id: string) => {
    const key = `${source}→${target}`;
    const p = pending.get(key) ?? { source, target, cents: 0, ids: new Set<string>() };
    p.cents += cents;
    p.ids.add(id);
    pending.set(key, p);
  };
  for (const l of lines) {
    const kind = lookup.categories.get(l.categoryId)?.kind;
    if (kind === "income") {
      add(node(`income:${l.categoryId}`, lookup.categories.get(l.categoryId)!.name, "income"), account(l.accountId), l.amountCents, l.transactionId);
    } else if (kind === "expense") {
      const from = account(l.accountId);
      const spent = -l.amountCents;
      if (by === "account") {
        add(from, node("spend:all", "Spending", "spend"), spent, l.transactionId);
      } else if (by === "merchant" && !topMerchants.has(l.merchant ?? "")) {
        add(from, node("spend:other-merchants", "Other merchants", "spend"), spent, l.transactionId);
      } else {
        const k = keysFor(l, by, lookup);
        const group = node(`spend:${k.key}`, k.label, "spend");
        add(from, group, spent, l.transactionId);
        // A subcategory branches off its parent; spending on the parent
        // itself stays there.
        if (k.child && !k.child.key.endsWith(":self")) add(group, node(`spend:${k.child.key}`, k.child.label, "spend"), spent, l.transactionId);
      }
    }
  }
  for (const p of pending.values()) if (p.cents > 0) flow(p.source, p.target, p.cents, p.ids);

  // Transfers, netted between each pair of accounts so money moved back and
  // forth shows once, in the direction it went on balance.
  const between = new Map<string, { a: string; b: string; cents: number; ids: Set<string> }>();
  for (const t of transfers) {
    if (t.toAccountId === null) {
      flow(account(t.fromAccountId), node(`transfer:${t.label}`, `${t.label} (other side not found)`, "transfer"), t.amountCents, [t.transactionId]);
      continue;
    }
    if (t.toAccountId === t.fromAccountId) continue;
    const [a, b] = [t.fromAccountId, t.toAccountId].sort();
    const pair = between.get(`${a}|${b}`) ?? { a, b, cents: 0, ids: new Set<string>() };
    pair.cents += t.fromAccountId === a ? t.amountCents : -t.amountCents;
    pair.ids.add(t.transactionId);
    between.set(`${a}|${b}`, pair);
  }
  for (const p of between.values()) {
    if (p.cents === 0) continue;
    const [from, to] = p.cents > 0 ? [p.a, p.b] : [p.b, p.a];
    flow(account(from), account(to), Math.abs(p.cents), p.ids);
  }

  const kept = [...links.values()].filter((l) => l.valueCents > 0).map(({ ids, ...l }) => ({ ...l, count: ids.size }));
  const used = new Set(kept.flatMap((l) => [l.source, l.target]));
  return { nodes: [...nodes.values()].filter((n) => used.has(n.id)), links: kept };
}
