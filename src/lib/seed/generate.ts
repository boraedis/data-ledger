// Synthetic data for local and preview databases. Every institution,
// merchant, employer and person here is invented — this repo is public and
// real financial data never enters it (AGENTS.md). If you extend this, keep
// it that way: no real merchant descriptors lifted from a statement.
//
// Deterministic for a given seed and end date, so a bug seen on one preview
// reproduces on another. The shapes are chosen to exercise features that
// come later: a subscription price rise (#9), an annual charge (#7), shared
// dinners followed by friends paying back over a payment app (#8).

export type SeedAccount = {
  key: string;
  name: string;
  institution: string;
  type: "checking" | "savings" | "credit" | "payment_app" | "brokerage" | "loan";
};

// A day's balance per account, for net-worth history (#25).
export type SeedSnapshot = { accountKey: string; on: string; balanceCents: number };

// A day's position in the brokerage account (#23).
export type SeedHolding = {
  accountKey: string;
  on: string;
  externalId: string;
  symbol: string;
  description: string;
  shares: string;
  marketValueCents: number;
  costBasisCents: number | null;
  currency: string;
};

// Invented funds with invented tickers — not real securities. Shares are
// fixed, so each day's value moves with the account balance; a share of the
// account sits in cash. One position has no cost basis, as happens when a
// brokerage doesn't have it (e.g. shares transferred in).
const SEED_POSITIONS = [
  { externalId: "seed-pos-1", symbol: "EXTM", description: "Example Total Market Index Fund", shares: "182.4071", weight: 0.62, costBasisCents: 2_050_000 },
  { externalId: "seed-pos-2", symbol: "EXIN", description: "Example International Index Fund", shares: "310.5", weight: 0.23, costBasisCents: 960_000 },
  { externalId: "seed-pos-3", symbol: "EXBD", description: "Example Bond Index Fund", shares: "95", weight: 0.11, costBasisCents: null },
] as const;

export type SeedTransaction = {
  accountKey: string;
  postedOn: string; // YYYY-MM-DD
  amountCents: number; // negative = money out
  description: string;
  externalId: string;
};

export type SeedCategory = { name: string; kind: "expense" | "income" | "transfer" };

export const SEED_ACCOUNTS: SeedAccount[] = [
  { key: "checking", name: "Everyday Checking", institution: "Example Community Credit Union", type: "checking" },
  { key: "savings", name: "Rainy Day Savings", institution: "Example Community Credit Union", type: "savings" },
  { key: "card", name: "Rewards Card", institution: "Placeholder Card Co.", type: "credit" },
  { key: "p2p", name: "PayPeer", institution: "PayPeer", type: "payment_app" },
  // Balance-only accounts: no transactions, just history, so net worth has
  // an investment and a debt to show.
  { key: "brokerage", name: "Index Fund Account", institution: "Example Brokerage", type: "brokerage" },
  { key: "auto", name: "Auto Loan", institution: "Example Community Credit Union", type: "loan" },
];

// Where each cash account's balance stood the day before the window, so
// the daily balances that follow from the transactions stay plausible.
const OPENING_BALANCES: Record<string, number> = { checking: 640_000, savings: 1_200_000, card: -95_000, p2p: 40_000 };

// A starter set only. Categories are the owner's to shape; this just gives a
// fresh database something to categorize into.
export const SEED_CATEGORIES: SeedCategory[] = [
  { name: "Groceries", kind: "expense" },
  { name: "Dining", kind: "expense" },
  { name: "Coffee", kind: "expense" },
  { name: "Rent", kind: "expense" },
  { name: "Utilities", kind: "expense" },
  { name: "Subscriptions", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Fitness", kind: "expense" },
  { name: "Car", kind: "expense" },
  { name: "Paycheck", kind: "income" },
  { name: "Interest", kind: "income" },
  { name: "Transfers", kind: "transfer" },
];

const FRIENDS = ["ALEX RIVERA", "SAM OKAFOR", "PRIYA NANDAKUMAR", "JORDAN BELLWEATHER"];

// mulberry32: tiny, fast, good enough for fake data, and seedable — which
// Math.random isn't.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function generateSeed({ endDate, months = 6, seed = 42 }: { endDate: Date; months?: number; seed?: number }) {
  const random = rng(seed);
  const between = (min: number, max: number) => Math.round(min + random() * (max - min));
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];

  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate()));

  const txns: Omit<SeedTransaction, "externalId">[] = [];
  const add = (accountKey: string, day: Date, amountCents: number, description: string) => {
    if (day >= start && day <= end) txns.push({ accountKey, postedOn: iso(day), amountCents, description });
  };

  // Payroll every other Friday from the first Friday on or after start.
  let payday = new Date(start);
  while (payday.getUTCDay() !== 5) payday = addDays(payday, 1);
  for (; payday <= end; payday = addDays(payday, 14)) {
    add("checking", payday, 245_000 + between(-500, 500), "ACME WIDGETS INC DIRECT DEP PAYROLL");
  }

  for (let m = 0; m <= months; m++) {
    const month = (day: number) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, day));

    add("checking", month(1), -185_000, "MAPLEWOOD PROPERTY MGMT ONLINE PMT RENT");
    add("checking", month(between(8, 12)), -between(6_500, 14_000), "CITY POWER & LIGHT AUTOPAY");
    add("checking", month(15), -30_000, "ONLINE TRANSFER TO SAVINGS XXXXXX");
    add("savings", month(15), 30_000, "ONLINE TRANSFER FROM CHECKING XXXXXX");
    add("savings", month(28), between(800, 1_400), "INTEREST PAYMENT");

    // Card subscriptions. Streamflix raises its price three months in, the
    // kind of quiet increase #9's alerts exist to catch.
    add("card", month(3), m < 3 ? -1_549 : -1_799, "STREAMFLIX.COM 800-555-0100");
    add("card", month(7), -1_099, "TUNEBOX MUSIC SUBSCR");
    add("card", month(5), -4_500, "IRONWORKS GYM MEMBERSHIP");

  }

  // Annual charges, once in the window: a budget period that isn't monthly.
  add("card", addDays(start, 40), -9_999, "CLOUDLOCKER STORAGE ANNUAL PLAN");
  add("checking", addDays(start, 95), -18_650, "STATE MOTOR VEHICLES REGISTRATION RENEWAL");

  // Day-to-day card spending.
  for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
    if (random() < 0.55) add("card", day, -between(450, 925), "CORNER BEAN CAFE #12");
    if (random() < 0.22) add("card", day, -between(3_800, 14_500), "QUILLFIELD MARKET #0412");
    if (random() < 0.12) add("card", day, -between(1_100, 3_400), `ZIPRIDE *TRIP ${between(1000, 9999)}`);
    if (random() < 0.1) {
      add("card", day, -between(1_800, 6_500), pick(["LUCKY NOODLE HOUSE", "THE PATIO GRILL", "SAFFRON & SALT"]));
    }

    // Shared dinner: the owner pays, then one to three friends pay back
    // their share over the payment app a day or few later. Those incoming
    // payments are reimbursements, not income (#8).
    if (random() < 0.04) {
      const guests = between(1, 3);
      const totalCents = between(9_000, 24_000);
      const shareCents = Math.round(totalCents / (guests + 1));
      add("card", day, -totalCents, pick(["TRATTORIA VERDE", "HARBORSIDE OYSTER BAR", "SMOKE & EMBER BBQ"]));
      const friends = [...FRIENDS].sort(() => random() - 0.5).slice(0, guests);
      for (const friend of friends) {
        add("p2p", addDays(day, between(0, 4)), shareCents, `PAYPEER PAYMENT FROM ${friend}`);
      }
    }
  }

  // Paying the card off from checking on the 20th — a transfer, not
  // spending. Paid in full: whatever was charged since the last payment, so
  // the card's balance stays a realistic debt rather than drifting.
  let lastPayment = "";
  for (let m = 0; m <= months; m++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 20));
    if (day < start || day > end) continue;
    const on = iso(day);
    const charged = txns
      .filter((t) => t.accountKey === "card" && t.postedOn > lastPayment && t.postedOn <= on)
      .reduce((sum, t) => sum + t.amountCents, 0);
    lastPayment = on;
    if (charged >= 0) continue;
    add("checking", day, charged, "PLACEHOLDER CARD CO PAYMENT");
    add("card", day, -charged, "PAYMENT THANK YOU");
  }

  // Sweep the payment-app balance to checking monthly, as people do.
  for (let m = 1; m <= months; m++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 2));
    const sweep = between(5_000, 15_000);
    add("p2p", day, -sweep, "PAYPEER TRANSFER TO BANK");
    add("checking", day, sweep, "PAYPEER TRANSFER");
  }

  txns.sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.description.localeCompare(b.description));
  const transactions: SeedTransaction[] = txns.map((t, i) => ({ ...t, externalId: `seed-${i}` }));

  // Daily balances. Cash accounts follow their own transactions from the
  // opening balance. The card is reported negative when owed and the loan
  // positive, as real providers disagree — exercising both sides of the
  // net-worth sign convention (src/lib/net-worth.ts).
  const snapshots: SeedSnapshot[] = [];
  const holdings: SeedHolding[] = [];
  const running = { ...OPENING_BALANCES };
  let brokerage = 3_850_000;
  let loan = 1_420_000;
  let t = 0;
  for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
    const on = iso(day);
    for (; t < transactions.length && transactions[t].postedOn === on; t++) {
      running[transactions[t].accountKey] += transactions[t].amountCents;
    }
    // A market that drifts up with daily noise, and a loan paid down monthly.
    brokerage = Math.round(brokerage * (1 + (random() - 0.47) * 0.012));
    if (day.getUTCDate() === 10) loan = Math.max(0, loan - 41_500);
    for (const [accountKey, balanceCents] of Object.entries(running)) snapshots.push({ accountKey, on, balanceCents });
    snapshots.push({ accountKey: "brokerage", on, balanceCents: brokerage });
    for (const { weight, ...position } of SEED_POSITIONS) {
      holdings.push({ ...position, accountKey: "brokerage", on, marketValueCents: Math.round(brokerage * weight), currency: "USD" });
    }
    snapshots.push({ accountKey: "auto", on, balanceCents: loan });
  }

  return { accounts: SEED_ACCOUNTS, categories: SEED_CATEGORIES, transactions, snapshots, holdings };
}
