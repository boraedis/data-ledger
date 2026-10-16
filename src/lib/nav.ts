// The app's navigation (#68): six sections in the top bar, each with its
// own pages as tabs underneath, plus an account menu for what isn't a
// destination you visit daily. One list, so the top bar, the tabs and the
// phone menu can't disagree.

export type NavPage = { href: string; label: string };
export type NavSection = { id: string; label: string; pages: NavPage[] };

export const SECTIONS: NavSection[] = [
  { id: "home", label: "Home", pages: [{ href: "/", label: "Home" }] },
  { id: "inbox", label: "Inbox", pages: [{ href: "/inbox", label: "Inbox" }] },
  {
    id: "transactions",
    label: "Transactions",
    pages: [
      { href: "/transactions", label: "Transactions" },
      { href: "/categories", label: "Categories" },
    ],
  },
  {
    id: "plan",
    label: "Plan",
    pages: [
      { href: "/budgets", label: "Budgets" },
      { href: "/goals", label: "Goals" },
      { href: "/subscriptions", label: "Subscriptions" },
      { href: "/owed", label: "Owed to me" },
    ],
  },
  {
    id: "wealth",
    label: "Wealth",
    pages: [
      { href: "/net-worth", label: "Net worth" },
      { href: "/investments", label: "Investments" },
      { href: "/accounts", label: "Accounts" },
      { href: "/pay", label: "Pay" },
    ],
  },
  { id: "tally", label: "Tally", pages: [{ href: "/tally", label: "Tally" }] },
];

// Not sections: the account menu.
export const ACCOUNT_PAGES: NavPage[] = [
  { href: "/settings", label: "Settings" },
  { href: "/activity", label: "Activity" },
];

const matches = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

/** The page a path belongs to: the longest matching href, so /transactions/abc is Transactions. */
export function pageFor(pathname: string): NavPage | null {
  const all = [...SECTIONS.flatMap((s) => s.pages), ...ACCOUNT_PAGES];
  return all.filter((p) => matches(pathname, p.href)).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}

/** The section a path is in, or null on an account page (Settings, Activity). */
export function sectionFor(pathname: string): NavSection | null {
  const page = pageFor(pathname);
  return page ? (SECTIONS.find((s) => s.pages.some((p) => p.href === page.href)) ?? null) : null;
}
