// Backfilling history from a bank's CSV export (#35), the parts with no
// database: reading the file, the owner's column mapping, exact amounts and
// dates, a stable ID per row so a re-import adds nothing, and which rows
// look like transactions the sync already has. Pure, so every rule is
// tested on synthetic files; the file itself is read in memory and never
// stored.

// --- Reading -------------------------------------------------------------------

/**
 * Rows of a CSV file: quoted fields (with "" for a quote, and commas or line
 * breaks inside), CRLF or LF, a leading byte-order mark. Blank lines are
 * dropped. Small on purpose: bank exports are plain, and a library would
 * be a dependency for a few dozen lines.
 */
export function readCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// --- Values ----------------------------------------------------------------------

/**
 * Exact integer cents from a bank's amount text: "$1,234.56", "-12.5",
 * "(12.50)" and "12.50-" (both negative), "+3". Null for blank or anything
 * else. Never through a float.
 */
export function parseAmountCents(text: string): number | null {
  let t = text.trim().replace(/[$\s]/g, "").replace(/,/g, "");
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith("-")) {
    negative = !negative;
    t = t.slice(0, -1);
  }
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m || (m[1] === "" && !m[2])) return null;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return negative ? -cents : cents;
}

export const DATE_FORMATS = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD", "MM-DD-YYYY", "MM/DD/YY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** An ISO date from a bank's date text in the given format, or null if it doesn't read as one. */
export function parseDate(text: string, format: DateFormat): string | null {
  const t = text.trim().split(/[ T]/)[0];
  const parts = t.split(/[/-]/);
  if (parts.length !== 3) return null;
  let y: number, m: number, d: number;
  if (format === "YYYY-MM-DD") [y, m, d] = parts.map(Number);
  else if (format === "DD/MM/YYYY") [d, m, y] = parts.map(Number);
  else [m, d, y] = parts.map(Number);
  if (format === "MM/DD/YY") y = y < 100 ? 2000 + y : y;
  if (![y, m, d].every(Number.isInteger) || y < 1900 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// --- Mapping ---------------------------------------------------------------------

export type Mapping = {
  // Rows to skip before the header (some banks put an account summary first).
  skipRows: number;
  hasHeader: boolean;
  date: number;
  dateFormat: DateFormat;
  description: number;
  // One signed column, or separate money-out and money-in columns.
  amount: { kind: "signed"; column: number; flip: boolean } | { kind: "split"; debit: number; credit: number };
};

const find = (header: string[], ...patterns: RegExp[]) => {
  for (const p of patterns) {
    const i = header.findIndex((h) => p.test(h.trim()));
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * A first guess from the header names and the first dates, for the owner
 * to correct. The header is the first line (of the first ten) with a
 * column named like a date, so an account summary above it is skipped.
 */
export function guessMapping(all: string[][]): Mapping {
  const found = all.slice(0, 10).findIndex((r) => r.length > 1 && r.some((c) => /date/i.test(c.trim())));
  const skipRows = Math.max(0, found);
  const rows = all.slice(skipRows);
  const header = rows[0] ?? [];
  const date = Math.max(0, find(header, /^(posting|post|posted)? ?date$/i, /^trans(action)?\.? ?date$/i, /date/i));
  const description = Math.max(0, find(header, /^description$/i, /desc/i, /payee|merchant|name|memo/i));
  const amount = find(header, /^amount$/i, /amount/i);
  const debit = find(header, /debit|withdraw|money out|charge/i);
  const credit = find(header, /credit|deposit|money in|payment/i);
  const sample = rows.slice(1, 20).map((r) => r[date] ?? "");
  const dateFormat = DATE_FORMATS.find((f) => sample.length > 0 && sample.every((s) => parseDate(s, f))) ?? "MM/DD/YYYY";
  return {
    skipRows,
    hasHeader: true,
    date,
    dateFormat,
    description,
    amount: amount < 0 && debit >= 0 && credit >= 0 ? { kind: "split", debit, credit } : { kind: "signed", column: Math.max(0, amount), flip: false },
  };
}

export type ParsedRow = { row: number; postedOn: string; amountCents: number; description: string; externalId: string };
export type RowError = { row: number; message: string };

// FNV-1a, 32-bit: a short, stable fingerprint of a description for the
// row's ID. Not security, just "the same text gives the same ID".
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The file's transactions under a mapping, and the rows it couldn't read
 * (numbered as in the file, from 1). Each row's ID is built from its date,
 * amount, description and how many identical rows came before it, so
 * importing the same file again matches every row (two identical $4.50
 * coffees on one day stay two).
 */
export function applyMapping(rows: string[][], mapping: Mapping): { rows: ParsedRow[]; errors: RowError[] } {
  const parsed: ParsedRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  const start = mapping.skipRows + (mapping.hasHeader ? 1 : 0);
  rows.slice(start).forEach((cells, i) => {
    const row = start + i + 1;
    const postedOn = parseDate(cells[mapping.date] ?? "", mapping.dateFormat);
    const description = (cells[mapping.description] ?? "").trim().replace(/\s+/g, " ");
    let amountCents: number | null;
    if (mapping.amount.kind === "signed") {
      const a = parseAmountCents(cells[mapping.amount.column] ?? "");
      amountCents = a === null ? null : mapping.amount.flip ? -a : a;
    } else {
      // Money out is negative whichever way the bank wrote it.
      const debit = parseAmountCents(cells[mapping.amount.debit] ?? "");
      const credit = parseAmountCents(cells[mapping.amount.credit] ?? "");
      amountCents = debit === null && credit === null ? null : (credit === null ? 0 : Math.abs(credit)) - (debit === null ? 0 : Math.abs(debit));
    }
    if (!postedOn) return errors.push({ row, message: `Date "${(cells[mapping.date] ?? "").trim()}" isn't ${mapping.dateFormat}` });
    if (amountCents === null) return errors.push({ row, message: "No amount" });
    if (!description) return errors.push({ row, message: "No description" });
    // A running-balance or summary line that slipped through: no money moved.
    if (amountCents === 0) return errors.push({ row, message: "Amount is zero" });
    const key = `${postedOn}|${amountCents}|${description.toLowerCase()}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    parsed.push({ row, postedOn, amountCents, description, externalId: `csv:${postedOn}:${amountCents}:${fingerprint(description.toLowerCase())}:${n}` });
  });
  return { rows: parsed, errors };
}

// --- Overlap with what's already there --------------------------------------------

// How far apart a CSV row and a synced transaction can be dated and still
// be the same one: banks date a card purchase by when it was made in the
// export but when it posted in the feed.
export const OVERLAP_DAYS = 3;

export type Existing = { id: string; postedOn: string; amountCents: number; description: string };

/**
 * For each file row, the transaction already in the account that's most
 * likely the same one: the exact amount within a few days, closest date
 * first, then the most similar description. Each existing transaction
 * answers for one row at most. These are shown as "already here" and
 * skipped unless the owner says otherwise; nothing merges.
 */
export function findOverlaps(rows: ParsedRow[], existing: Existing[]): Map<number, Existing> {
  const DAY = 86_400_000;
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const similarity = (a: string, b: string) => {
    const [x, y] = [words(a), words(b)];
    return [...x].filter((w) => y.has(w)).length;
  };
  const claimed = new Set<string>();
  const result = new Map<number, Existing>();
  for (const r of [...rows].sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.row - b.row)) {
    const match = existing
      .filter((e) => !claimed.has(e.id) && e.amountCents === r.amountCents && days(e.postedOn, r.postedOn) <= OVERLAP_DAYS)
      .sort((a, b) => days(a.postedOn, r.postedOn) - days(b.postedOn, r.postedOn) || similarity(b.description, r.description) - similarity(a.description, r.description))[0];
    if (match) {
      claimed.add(match.id);
      result.set(r.row, match);
    }
  }
  return result;
}
