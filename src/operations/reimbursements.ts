import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, people, reimbursementMatches, reimbursements, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { CASH_KINDS } from "@/lib/investments/activity";
import { PAID_BEFORE_GRACE_DAYS, personInText, proposeAllocations, type Proposal } from "@/lib/reimbursements/match";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError, type WriteContext } from "@/operations/tracked";

// Shared expenses and reimbursements (#8). The owner marks an expense as
// shared — what each person owes — and incoming payments are matched
// against it. Net spend (transactions.spendingLines) counts only the
// owner's share, and the matched part of a payment is never income.
//
// Names and amounts of friends' payments are ordinary transaction data, so
// Tally may read them; its writes are proposals like any other.

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const name = z.string().trim().min(1).max(80);

// --- People -------------------------------------------------------------------

export const listPeople = defineRead({
  name: "people.list",
  description: "The people who share expenses with the owner, with the alternate spellings payment apps use for them.",
  input: z.object({}),
  run: (db) => db.select({ id: people.id, name: people.name, aliases: people.aliases }).from(people).orderBy(people.name),
});

const aliases = z.array(name).max(10).default([]);

export const createPerson = defineWrite({
  name: "people.create",
  description: "Add a person who shares expenses. aliases are other spellings to recognize in payments (\"ALEX R\").",
  input: z.object({ name, aliases }),
  apply: async (ctx, input) => {
    const [clash] = await ctx.db.select({ id: people.id }).from(people).where(sql`lower(${people.name}) = lower(${input.name})`);
    if (clash) throw new Error(`There's already someone called ${input.name}`);
    return ctx.insert(people, { name: input.name, aliases: input.aliases });
  },
});

export const updatePerson = defineWrite({
  name: "people.update",
  description: "Rename a person or change the spellings recognized in their payments.",
  input: z.object({ personId: z.uuid(), name: name.optional(), aliases: z.array(name).max(10).optional() }),
  apply: async (ctx, { personId, ...set }) => {
    if (set.name === undefined && set.aliases === undefined) throw new Error("Nothing to change");
    return ctx.update(people, personId, set);
  },
});

// --- Shares -----------------------------------------------------------------

async function matchedByReimbursement(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ id: reimbursementMatches.reimbursementId, cents: sql<number>`sum(${reimbursementMatches.amountCents})`.mapWith(Number) })
    .from(reimbursementMatches)
    .where(inArray(reimbursementMatches.reimbursementId, ids))
    .groupBy(reimbursementMatches.reimbursementId);
  return new Map(rows.map((r) => [r.id, r.cents]));
}

export const setShares = defineWrite({
  name: "reimbursements.setShares",
  description:
    "Mark an expense as shared: what each person owes the owner (positive cents). Replaces the expense's " +
    "current shares; the owner's share is the rest. An empty list un-shares it. A share can't drop below what " +
    "that person has already paid back.",
  input: z.object({
    transactionId: z.uuid(),
    shares: z
      .array(z.object({ personId: z.uuid(), amountCents: z.number().int().min(1) }))
      .max(20)
      .refine((s) => new Set(s.map((x) => x.personId)).size === s.length, "One share per person"),
  }),
  apply: async (ctx, { transactionId, shares }) => {
    const [txn] = await ctx.db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!txn) throw new NotFoundError("Transaction not found");
    if (txn.amountCents >= 0) throw new Error("Only money spent can be shared");
    if (txn.pending) throw new Error("Wait until it posts: a pending transaction can be replaced when it does");
    const owed = shares.reduce((s, x) => s + x.amountCents, 0);
    if (owed > -txn.amountCents) throw new Error("Friends can't owe more than the whole expense");
    if (shares.length) {
      const found = await ctx.db.select({ id: people.id }).from(people).where(inArray(people.id, shares.map((s) => s.personId)));
      if (found.length !== shares.length) throw new NotFoundError("Person not found");
    }

    const existing = await ctx.db.select().from(reimbursements).where(eq(reimbursements.transactionId, transactionId));
    const paid = await matchedByReimbursement(ctx.db, existing.map((e) => e.id));
    for (const old of existing) {
      const next = shares.find((s) => s.personId === old.personId);
      const received = paid.get(old.id) ?? 0;
      if (received > (next?.amountCents ?? 0)) {
        throw new Error("Someone has already paid back more than that; unmatch their payment first");
      }
      // Same person: keep the row, so their matched payments stay attached.
      if (!next) await ctx.remove(reimbursements, old.id);
      else if (next.amountCents !== old.amountCents) await ctx.update(reimbursements, old.id, { amountCents: next.amountCents });
    }
    for (const share of shares.filter((s) => !existing.some((e) => e.personId === s.personId))) {
      await ctx.insert(reimbursements, { transactionId, personId: share.personId, amountCents: share.amountCents });
    }
    return { yourShareCents: -txn.amountCents - owed, owedCents: owed };
  },
});

export const forgive = defineWrite({
  name: "reimbursements.forgive",
  description: "Stop expecting the rest of a reimbursement. Its unpaid part counts as the owner's own spending again.",
  input: z.object({ reimbursementId: z.uuid() }),
  apply: async (ctx, { reimbursementId }) => ctx.update(reimbursements, reimbursementId, { forgiven: true }),
});

// --- Matching -----------------------------------------------------------------

export const match = defineWrite({
  name: "reimbursements.match",
  description:
    "Apply an incoming payment to what people owe: allocations of its amount (cents) to reimbursements. One " +
    "payment can cover several, and a reimbursement can be paid in parts. The matched part is never income.",
  input: z.object({
    transactionId: z.uuid(),
    allocations: z.array(z.object({ reimbursementId: z.uuid(), amountCents: z.number().int().min(1) })).min(1).max(20),
  }),
  apply: async (ctx, { transactionId, allocations }) => {
    const [payment] = await ctx.db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!payment) throw new NotFoundError("Transaction not found");
    if (payment.amountCents <= 0) throw new Error("Only money received can pay someone back");
    if (payment.pending) throw new Error("Wait until it posts: a pending transaction can be replaced when it does");
    if (payment.provisionalSource) throw new Error("Wait until the bank reports it: a provisional transaction is replaced when it does");
    const [{ cents: already }] = await ctx.db
      .select({ cents: sql<number>`coalesce(sum(${reimbursementMatches.amountCents}), 0)`.mapWith(Number) })
      .from(reimbursementMatches)
      .where(eq(reimbursementMatches.transactionId, transactionId));
    const total = allocations.reduce((s, a) => s + a.amountCents, 0);
    if (already + total > payment.amountCents) throw new Error("That's more than the payment left to apply");

    const ids = allocations.map((a) => a.reimbursementId);
    const items = await ctx.db.select().from(reimbursements).where(inArray(reimbursements.id, ids));
    const paid = await matchedByReimbursement(ctx.db, ids);
    for (const a of allocations) {
      const item = items.find((i) => i.id === a.reimbursementId);
      if (!item) throw new NotFoundError("Reimbursement not found");
      if (item.transactionId === transactionId) throw new Error("A payment can't reimburse itself");
      if (item.forgiven) throw new Error("That reimbursement was forgiven");
      const remaining = item.amountCents - (paid.get(item.id) ?? 0);
      if (a.amountCents > remaining) throw new Error("That's more than is still owed on it");
      paid.set(item.id, (paid.get(item.id) ?? 0) + a.amountCents);
      await ctx.insert(reimbursementMatches, { reimbursementId: a.reimbursementId, transactionId, amountCents: a.amountCents });
    }
    return { matchedCents: total };
  },
});

export const unmatch = defineWrite({
  name: "reimbursements.unmatch",
  description: "Undo every match of an incoming payment: it's an ordinary transaction again, and what it covered is owed again.",
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx, { transactionId }) => {
    const rows = await ctx.db.select({ id: reimbursementMatches.id }).from(reimbursementMatches).where(eq(reimbursementMatches.transactionId, transactionId));
    if (rows.length === 0) throw new Error("This payment isn't matched to anything");
    for (const { id } of rows) await ctx.remove(reimbursementMatches, id);
    return { removed: rows.length };
  },
});

export const dismissPayment = defineWrite({
  name: "reimbursements.dismiss",
  description: "Say an incoming payment isn't anyone paying the owner back (a gift, a sale), so it stops being proposed as a match.",
  input: z.object({ transactionId: z.uuid() }),
  apply: async (ctx: WriteContext, { transactionId }) => ctx.update(transactions, transactionId, { notReimbursement: true }),
});

// --- Reads ----------------------------------------------------------------------

type OpenRow = {
  reimbursementId: string;
  personId: string;
  personName: string;
  transactionId: string;
  date: string;
  merchant: string;
  expenseCents: number;
  owedCents: number;
  receivedCents: number;
  remainingCents: number;
  ageDays: number;
};

async function openItems(db: Db, on: string): Promise<OpenRow[]> {
  const rows = await db
    .select({
      reimbursementId: reimbursements.id,
      personId: people.id,
      personName: people.name,
      transactionId: transactions.id,
      date: transactions.postedOn,
      merchant: sql<string>`coalesce(${transactions.merchant}, ${transactions.description})`,
      expenseCents: transactions.amountCents,
      owedCents: reimbursements.amountCents,
    })
    .from(reimbursements)
    .innerJoin(people, eq(people.id, reimbursements.personId))
    .innerJoin(transactions, eq(transactions.id, reimbursements.transactionId))
    .where(eq(reimbursements.forgiven, false));
  const paid = await matchedByReimbursement(db, rows.map((r) => r.reimbursementId));
  return rows
    .map((r) => {
      const receivedCents = paid.get(r.reimbursementId) ?? 0;
      return {
        ...r,
        expenseCents: -r.expenseCents,
        receivedCents,
        remainingCents: r.owedCents - receivedCents,
        ageDays: Math.max(0, Math.round((Date.parse(on) - Date.parse(r.date)) / DAY_MS)),
      };
    })
    .filter((r) => r.remainingCents > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Aging buckets for "owed to me": how long it's been since the expense.
export const AGING_BUCKETS = [
  { label: "0–30 days", max: 30 },
  { label: "31–60 days", max: 60 },
  { label: "61–90 days", max: 90 },
  { label: "Over 90 days", max: Infinity },
] as const;

export const owedToMe = defineRead({
  name: "reimbursements.owed",
  description:
    "What people still owe the owner: each open reimbursement (expense, owed, received, remaining, age in days) " +
    "and a per-person total with aging buckets (0–30, 31–60, 61–90, over 90 days since the expense).",
  input: z.object({ on: z.iso.date().optional() }),
  run: async (db, { on = today() }) => {
    const items = await openItems(db, on);
    const byPerson = new Map<string, { personId: string; personName: string; totalCents: number; buckets: number[]; oldestDays: number }>();
    for (const item of items) {
      const entry = byPerson.get(item.personId) ?? {
        personId: item.personId,
        personName: item.personName,
        totalCents: 0,
        buckets: AGING_BUCKETS.map(() => 0),
        oldestDays: 0,
      };
      entry.totalCents += item.remainingCents;
      entry.buckets[AGING_BUCKETS.findIndex((b) => item.ageDays <= b.max)] += item.remainingCents;
      entry.oldestDays = Math.max(entry.oldestDays, item.ageDays);
      byPerson.set(item.personId, entry);
    }
    return {
      totalCents: items.reduce((s, i) => s + i.remainingCents, 0),
      people: [...byPerson.values()].sort((a, b) => b.totalCents - a.totalCents),
      items,
    };
  },
});

export const proposals = defineRead({
  name: "reimbursements.proposals",
  description:
    "Incoming payments that look like someone paying the owner back, each with the person (recognized by " +
    "name in the description) and a proposed allocation to what they owe: exact, combined (one payment for " +
    "several expenses), partial, or more than owed. Proposals only; confirm with reimbursements.match.",
  input: z.object({ on: z.iso.date().optional() }),
  run: async (db, { on = today() }) => {
    const [peopleRows, items] = await Promise.all([db.select().from(people), openItems(db, on)]);
    if (peopleRows.length === 0 || items.length === 0) return [];
    // Payments from a few days before the oldest open debt onward.
    const since = new Date(Date.parse(items[0].date) - PAID_BEFORE_GRACE_DAYS * DAY_MS).toISOString().slice(0, 10);
    const payments = await db
      .select({
        id: transactions.id,
        date: transactions.postedOn,
        amountCents: transactions.amountCents,
        description: transactions.description,
        payee: transactions.payee,
        memo: transactions.memo,
        accountName: sql<string>`coalesce(${accounts.displayName}, ${accounts.name})`,
        matchedCents: sql<number>`coalesce((select sum(${reimbursementMatches.amountCents}) from ${reimbursementMatches} where ${reimbursementMatches.transactionId} = ${transactions.id}), 0)`.mapWith(Number),
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          sql`${transactions.amountCents} > 0`,
          eq(transactions.pending, false),
          isNull(transactions.provisionalSource),
          eq(transactions.notReimbursement, false),
          isNull(transactions.transferPairId),
          gte(transactions.postedOn, since),
          inArray(accounts.type, [...CASH_KINDS]),
        ),
      )
      .orderBy(transactions.postedOn, transactions.id);

    // Two passes, oldest payment first within each, every proposal taking
    // from what's still open after the ones before it, so two payments
    // never claim the same debt. Exact and combined matches go first: an
    // unrelated earlier payment from the same friend must not claim a debt
    // as a weak partial match before the payment that matches it exactly.
    const remaining = new Map(items.map((i) => [i.reimbursementId, i.remainingCents]));
    type Row = {
      transactionId: string;
      date: string;
      amountCents: number;
      unmatchedCents: number;
      description: string;
      accountName: string;
      personId: string;
      personName: string;
      kind: Proposal["kind"];
      allocations: (Proposal["allocations"][number] & { merchant: string; date: string })[];
    };
    const result: Row[] = [];
    const candidates = payments
      .map((p) => ({ ...p, unmatched: p.amountCents - p.matchedCents, personId: personInText(peopleRows, [p.description, p.payee, p.memo].filter(Boolean).join(" ")) }))
      .filter((p): p is typeof p & { personId: string } => p.unmatched > 0 && p.personId !== null);
    const proposed = new Set<string>();
    for (const exactOnly of [true, false]) {
      for (const p of candidates) {
        if (proposed.has(p.id)) continue;
        const theirs = items
          .filter((i) => i.personId === p.personId)
          .map((i) => ({ id: i.reimbursementId, date: i.date, remainingCents: remaining.get(i.reimbursementId)! }));
        const proposal = proposeAllocations({ date: p.date, remainingCents: p.unmatched }, theirs, { exactOnly });
        if (!proposal) continue;
        proposed.add(p.id);
        for (const a of proposal.allocations) remaining.set(a.reimbursementId, remaining.get(a.reimbursementId)! - a.amountCents);
        result.push({
          transactionId: p.id,
          date: p.date,
          amountCents: p.amountCents,
          unmatchedCents: p.unmatched,
          description: p.description,
          accountName: p.accountName,
          personId: p.personId,
          personName: peopleRows.find((x) => x.id === p.personId)!.name,
          kind: proposal.kind,
          allocations: proposal.allocations.map((a) => {
            const item = items.find((i) => i.reimbursementId === a.reimbursementId)!;
            return { ...a, merchant: item.merchant, date: item.date };
          }),
        });
      }
    }
    return result.sort((a, b) => b.date.localeCompare(a.date));
  },
});

/** For the transaction page: who owes what on this expense, and what this payment covers. */
export const transactionReimbursements = defineRead({
  name: "reimbursements.forTransaction",
  description:
    "A transaction's shared-expense details: each person's share with what they've paid back, and, for an " +
    "incoming payment, which reimbursements it was matched to.",
  input: z.object({ transactionId: z.uuid() }),
  run: async (db, { transactionId }) => {
    const shares = await db
      .select({ id: reimbursements.id, personId: people.id, personName: people.name, amountCents: reimbursements.amountCents, forgiven: reimbursements.forgiven })
      .from(reimbursements)
      .innerJoin(people, eq(people.id, reimbursements.personId))
      .where(eq(reimbursements.transactionId, transactionId))
      .orderBy(people.name);
    const paid = await matchedByReimbursement(db, shares.map((s) => s.id));
    const covers = await db
      .select({
        amountCents: reimbursementMatches.amountCents,
        personName: people.name,
        expenseId: transactions.id,
        expenseDate: transactions.postedOn,
        merchant: sql<string>`coalesce(${transactions.merchant}, ${transactions.description})`,
      })
      .from(reimbursementMatches)
      .innerJoin(reimbursements, eq(reimbursements.id, reimbursementMatches.reimbursementId))
      .innerJoin(people, eq(people.id, reimbursements.personId))
      .innerJoin(transactions, eq(transactions.id, reimbursements.transactionId))
      .where(eq(reimbursementMatches.transactionId, transactionId))
      .orderBy(desc(transactions.postedOn));
    return {
      shares: shares.map((s) => ({ ...s, receivedCents: paid.get(s.id) ?? 0 })),
      covers,
    };
  },
});
