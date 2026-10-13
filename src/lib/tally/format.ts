// Client-safe labels for Tally's tools and proposals.

const NOUNS: Record<string, string> = {
  transactions: "transactions",
  accounts: "accounts",
  categories: "categories",
  rules: "rules",
  budgets: "budgets",
  goals: "goals",
  recurring: "recurring charges",
  alerts: "alerts",
  people: "people",
  reimbursements: "shared expenses",
  investments: "investment income",
  tags: "tags",
};

/** "transactions.list" → "Looked at transactions". */
export function toolLabel(operation: string): string {
  const noun = NOUNS[operation.split(".")[0]] ?? operation.split(".")[0];
  return `Looked at ${noun}`;
}

/** "transactions.setCategory" → "Set category (transactions)". */
export function proposalLabel(operation: string): string {
  const [area, verb = ""] = operation.split(".");
  const words = verb.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${NOUNS[area] ?? area})`;
}
