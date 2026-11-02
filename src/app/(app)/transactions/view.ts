import { parseAmountCents } from "@/lib/money";
import { TRANSACTION_SOURCES, type TransactionFilter, type TransactionSource } from "@/operations/transactions";

// The Transactions list's view as a URL (#211): every filter reads from the
// query string and writes back to it, so any view is a link to share or
// bookmark. Pulled out of the page so that round trip is tested: a filter
// the page reads but forgets to write would vanish on the next page.

// The type filter (#208): one dropdown, one kind of row at a time, each
// value the list operation's own filter for it.
export const TYPES = {
  unmatched: { label: "Unmatched transfers", filter: "unmatchedTransfers" },
  uncategorized: { label: "Uncategorized", filter: "uncategorized" },
  paystub: { label: "Connected to a pay stub", filter: "payStubLinked" },
  flagged: { label: "Flagged", filter: "flagged" },
} as const;
export type TypeKey = keyof typeof TYPES;
const isType = (value: string | undefined): value is TypeKey => value !== undefined && Object.hasOwn(TYPES, value);

export const SOURCE_LABELS: Record<TransactionSource, string> = {
  bank: "From the bank",
  manual: "Added by hand",
  provisional: "From a purchase alert",
};

export type ListFilters = Pick<
  TransactionFilter,
  | "search"
  | "categoryId"
  | "tagId"
  | "accountId"
  | "from"
  | "to"
  | "amountMinCents"
  | "amountMaxCents"
  | "amountSigned"
  | "transferAccountId"
  | "payStubLinked"
  | "hasTags"
  | "split"
  | "pending"
  | "source"
>;

export type View = { filters: ListFilters; type?: TypeKey };

/** The filters that live in the More filters panel: it opens, and counts, by these. */
export const MORE_FILTERS = [
  "from",
  "to",
  "amountMinCents",
  "amountMaxCents",
  "transferAccountId",
  "payStubLinked",
  "hasTags",
  "split",
  "pending",
  "source",
] as const satisfies (keyof ListFilters)[];

type Params = Record<string, string | string[] | undefined>;

function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : undefined;
}

const isDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

// A typed dollar amount ("12", "-12.50", "$1,200") as cents; anything else
// is no filter rather than an error, as a hand-edited URL might hold.
function cents(value: string | undefined): number | undefined {
  const plain = value?.replace(/[$,]/g, "");
  if (!plain || !/^[+-]?\d+(\.\d{1,2})?$/.test(plain)) return undefined;
  return parseAmountCents(plain);
}

/** Cents back to the plain decimal a person types: 1050 → "10.50", -1200 → "-12". */
export function dollars(value: number): string {
  const abs = Math.abs(value);
  const rest = abs % 100;
  return `${value < 0 ? "-" : ""}${Math.floor(abs / 100)}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

const flag = (value: string | undefined) => (value === "1" ? true : undefined);

export function parseView(sp: Params): View {
  const amountSigned = flag(param(sp.signed));
  const min = cents(param(sp.min));
  const max = cents(param(sp.max));
  const source = param(sp.source);
  const filters: ListFilters = {
    search: param(sp.q),
    categoryId: param(sp.category),
    tagId: param(sp.tag),
    accountId: param(sp.account),
    from: isDay(param(sp.from)),
    to: isDay(param(sp.to)),
    // Unsigned, a range is on the amount's size, so a "-50" typed there
    // means 50.
    amountMinCents: min === undefined || amountSigned ? min : Math.abs(min),
    amountMaxCents: max === undefined || amountSigned ? max : Math.abs(max),
    amountSigned,
    transferAccountId: param(sp.xfer),
    payStubLinked: flag(param(sp.stub)),
    hasTags: flag(param(sp.tags)),
    split: flag(param(sp.split)),
    pending: flag(param(sp.pending)),
    source: (TRANSACTION_SOURCES as readonly string[]).includes(source ?? "") ? (source as TransactionSource) : undefined,
  };
  // ?unmatched=1, the type filter's older form, still works for saved links.
  const typeParam = param(sp.type) ?? (param(sp.unmatched) === "1" ? "unmatched" : undefined);
  return { filters, type: isType(typeParam) ? typeParam : undefined };
}

/** The view's URL, with `changes` applied: `{ from: undefined }` drops a filter, `page` picks a page. */
export function viewHref(view: View, changes: Partial<ListFilters> & { page?: number } = {}, path = "/transactions"): string {
  const { page, ...filterChanges } = changes;
  const f = { ...view.filters, ...filterChanges };
  const q = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined && value !== false && value !== "") q.set(key, value === true ? "1" : String(value));
  };
  set("q", f.search);
  set("category", f.categoryId);
  set("tag", f.tagId);
  set("account", f.accountId);
  set("type", view.type);
  set("from", f.from);
  set("to", f.to);
  set("min", f.amountMinCents === undefined ? undefined : dollars(f.amountMinCents));
  set("max", f.amountMaxCents === undefined ? undefined : dollars(f.amountMaxCents));
  set("signed", f.amountSigned);
  set("xfer", f.transferAccountId);
  set("stub", f.payStubLinked);
  set("tags", f.hasTags);
  set("split", f.split);
  set("pending", f.pending);
  set("source", f.source);
  if (page && page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Date presets for the panel, as of `today` (YYYY-MM-DD). */
export function datePresets(today: string): { label: string; from: string; to: string }[] {
  const [y, m] = today.split("-").map(Number);
  const monthStart = (year: number, month: number) => day(new Date(Date.UTC(year, month - 1, 1)));
  const monthEnd = (year: number, month: number) => day(new Date(Date.UTC(year, month, 0)));
  const back = (days: number) => day(new Date(Date.parse(today) - days * 86_400_000));
  return [
    { label: "This month", from: monthStart(y, m), to: today },
    { label: "Last month", from: monthStart(y, m - 1), to: monthEnd(y, m - 1) },
    { label: "Last 30 days", from: back(29), to: today },
    { label: "Last 90 days", from: back(89), to: today },
    { label: "This year", from: `${y}-01-01`, to: today },
    { label: "Last year", from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}
