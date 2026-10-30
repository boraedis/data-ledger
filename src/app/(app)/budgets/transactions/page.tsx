import Link from "next/link";
import { periodLabel } from "@/lib/budgets/format";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { targetTransactions } from "@/operations/budgets";
import { read } from "@/operations/runtime";
import { budgetView } from "@/lib/budgets/tabs";
import { BudgetTabs } from "../tabs";

// The transactions behind one budget card (#135): the lines budgets counted
// toward that target this period, from the same calculation as the card,
// so the total is always its "spent" figure. Not the Transactions page's
// filters: a card covers subcategories without a target of their own (the
// buffer, every category without one), dates a purchase by when it
// happened, and counts your share of a shared expense, and those filters
// can't say all that. ?target=<category id> or buffer, with the budget
// page's ?month= and ?gross=1.

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default async function TargetTransactionsPage(props: PageProps<"/budgets/transactions">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const view = budgetView(sp, today);
  const { month, thisMonth } = view;
  const on = month === thisMonth ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const gross = view.gross;
  const target = typeof sp.target === "string" ? sp.target : "buffer";
  const categoryId = target === "buffer" ? null : target;

  const back = (() => {
    const q = new URLSearchParams();
    if (month !== thisMonth) q.set("month", month);
    if (gross) q.set("gross", "1");
    const s = q.toString();
    return `/budgets${s ? `?${s}` : ""}#target-${target}`;
  })();

  const result = /^[0-9a-f-]{36}$|^buffer$/.test(target) ? await read(getDb(), targetTransactions, { categoryId, on, gross }) : null;

  return (
    <div className="space-y-4">
      {/* A month card's lines, so Month stays the current tab. */}
      <BudgetTabs current="month" view={view} />
      <Link href={back} className="text-sm text-muted-foreground hover:text-foreground">
        ← Budgets
      </Link>
      {!result ? (
        <p className="text-muted-foreground">There&apos;s no such target in effect then.</p>
      ) : (
        <>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">{result.name}</h1>
            <p className="text-sm text-muted-foreground">
              {periodLabel(result.start, result.end)}
              {on < result.end ? " so far" : ""} · {gross ? "gross: amounts as charged" : "your share of shared expenses"}
              {categoryId === null ? " · every expense category without a target of its own" : ""}
            </p>
          </div>
          {result.lines.length === 0 ? (
            <p className="text-muted-foreground">Nothing spent{on < result.end ? " yet" : ""}.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {result.lines.map((l, i) => (
                <li key={`${l.transactionId}-${i}`}>
                  <Link href={`/transactions/${l.transactionId}`} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-accent">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{l.merchant ?? l.description}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {day(l.date)} · {l.accountName} · {l.categoryName}
                        {l.splitPart ? " · part of a split" : ""}
                      </span>
                    </span>
                    {/* Spending as a positive amount, like the card; a refund shows as money back. */}
                    <span className={`shrink-0 tabular-nums ${l.amountCents > 0 ? "text-positive" : ""}`}>
                      {l.amountCents > 0 ? `−${formatCents(l.amountCents)}` : formatCents(-l.amountCents)}
                    </span>
                  </Link>
                </li>
              ))}
              <li className="flex justify-between gap-3 px-3 py-2 font-medium">
                <span>
                  Spent ({result.lines.length} {result.lines.length === 1 ? "line" : "lines"})
                </span>
                <span className="tabular-nums">{formatCents(result.totalCents)}</span>
              </li>
            </ul>
          )}
          {result.totalCents !== result.spentCents ? (
            // Shouldn't happen: both come from the same lines. Said rather than hidden if it ever does.
            <p className="text-xs text-warning">This list totals {formatCents(result.totalCents)}, but the card shows {formatCents(result.spentCents)}.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
