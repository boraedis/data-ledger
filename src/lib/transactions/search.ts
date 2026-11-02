import { parseAmountCents } from "@/lib/money";

// What a Transactions search can mean besides text (#213): a date or an
// amount, as the list shows them. Each is tried alongside the merchant and
// description match, never instead of it: "2026" or "42" may well be in a
// description too, so a search only ever widens with these.

export type SearchAmount =
  // A sign means that direction only: "-42.50" is money out, as the list
  // writes it. Without one, either way: someone looking for 42.50 rarely
  // means only a refund or only a charge.
  { cents: number; signed: boolean };

export type SearchTerms = { text: string; amount: SearchAmount | null; date: string | null };

// Optional sign and $, thousands commas, at most two decimals: how amounts
// are written, and how the list prints them ("-$1,234.50").
const AMOUNT = /^([+-]?)\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The US order the rest of the app's dates aren't in, but people type.
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function realDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date rolls 2026-02-30 over to March: anything that moved isn't a date.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

export function searchTerms(search: string): SearchTerms {
  const text = search.trim();
  let amount: SearchAmount | null = null;
  const a = AMOUNT.exec(text);
  if (a) {
    const [, sign, whole, fraction] = a;
    const cents = Math.abs(parseAmountCents(`${whole.replaceAll(",", "")}${fraction ? `.${fraction}` : ""}`));
    amount = { cents: sign === "-" ? -cents : cents, signed: sign !== "" };
  }
  const iso = ISO_DATE.exec(text);
  const us = US_DATE.exec(text);
  const date = iso ? realDate(+iso[1], +iso[2], +iso[3]) : us ? realDate(+us[3], +us[1], +us[2]) : null;
  return { text, amount, date };
}
