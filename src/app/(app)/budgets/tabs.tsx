import Link from "next/link";
import { BUDGET_TABS, budgetHref, type BudgetTab, type BudgetView } from "@/lib/budgets/tabs";

// The tab bar on every budgets page (#145), the current one marked. It
// wraps rather than scrolls, so a phone never scrolls sideways.
export function BudgetTabs({ current, view }: { current: BudgetTab["id"] | null; view: BudgetView }) {
  return (
    <nav aria-label="Budgets" className="flex flex-wrap gap-1 text-sm">
      {BUDGET_TABS.map((t) => (
        <Link
          key={t.id}
          href={budgetHref(t.path, view)}
          aria-current={t.id === current ? "page" : undefined}
          className={`rounded-md px-3 py-1 ${t.id === current ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
