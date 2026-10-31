// The budgets pages' tab bar (#145). One list, so every page shows the same
// tabs. A tab's link carries the month being looked at and the gross/net
// setting, so switching from March's Month view opens the Year view ending
// in March, still gross if it was.

export type BudgetTab = { id: "dashboard" | "month" | "year" | "targets"; label: string; path: string };

export const BUDGET_TABS: BudgetTab[] = [
  { id: "dashboard", label: "Dashboard", path: "/budgets/dashboard" },
  { id: "month", label: "Month", path: "/budgets/month" },
  { id: "year", label: "Year", path: "/budgets/year" },
  { id: "targets", label: "Targets", path: "/budgets/targets" },
];

/** The state every tab keeps: the month (YYYY-MM) and whether spending is gross. */
export type BudgetView = { month: string; thisMonth: string; gross: boolean };

/** A budgets page's link, keeping the view; this month and net are the defaults, so they stay out of the URL. */
export function budgetHref(path: string, view: BudgetView): string {
  const q = new URLSearchParams();
  if (view.month !== view.thisMonth) q.set("month", view.month);
  if (view.gross) q.set("gross", "1");
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** The month and gross setting from a budgets page's search params, the month never later than this one. */
export function budgetView(sp: Record<string, string | string[] | undefined>, today: string): BudgetView {
  const thisMonth = today.slice(0, 7);
  const requested = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  return { month: requested > thisMonth ? thisMonth : requested, thisMonth, gross: sp.gross === "1" };
}

/** A budget item's own page (#174): its category id, or "buffer" for everything else. */
export const itemPath = (categoryId: string | null) => `/budgets/${categoryId ?? "buffer"}`;

/** A budget item's page, keeping the view. */
export const itemHref = (categoryId: string | null, view: BudgetView) => budgetHref(itemPath(categoryId), view);
