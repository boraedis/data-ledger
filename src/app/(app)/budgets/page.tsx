import { redirect } from "next/navigation";
import { budgetHref, budgetView } from "@/lib/budgets/tabs";

// The Budgets section opens on the dashboard (#193). The Month view lives at
// /budgets/month, and this keeps the month and gross setting on the way, so
// a link with ?month= still lands on the same month.
export default async function BudgetsPage(props: PageProps<"/budgets">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  redirect(budgetHref("/budgets/dashboard", budgetView(sp, today)));
}
