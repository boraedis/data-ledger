import { describe, expect, it } from "vitest";
import { applyMapping, findOverlaps, guessMapping, parseAmountCents, parseDate, readCsv, type Mapping } from "@/lib/history/csv";

// Synthetic exports only: invented merchants, amounts and dates.

describe("readCsv", () => {
  it("reads quoted fields, escaped quotes, commas and line breaks inside quotes, CRLF and a BOM", () => {
    const text = '﻿Date,Description,Amount\r\n01/05/2025,"LUMEN BISTRO, DOWNTOWN",-42.10\r\n01/06/2025,"SAYS ""HI""\nTWICE",3\r\n\r\n';
    expect(readCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["01/05/2025", "LUMEN BISTRO, DOWNTOWN", "-42.10"],
      ["01/06/2025", 'SAYS "HI"\nTWICE', "3"],
    ]);
  });
});

describe("parseAmountCents", () => {
  it("reads exact cents in every way banks write them", () => {
    expect(parseAmountCents("$1,234.56")).toBe(123_456);
    expect(parseAmountCents("-12.5")).toBe(-1_250);
    expect(parseAmountCents("(12.50)")).toBe(-1_250);
    expect(parseAmountCents("12.50-")).toBe(-1_250);
    expect(parseAmountCents("+3")).toBe(300);
    expect(parseAmountCents(".07")).toBe(7);
    expect(parseAmountCents("0.1")).toBe(10);
    expect(parseAmountCents("1234567.89")).toBe(123_456_789);
  });

  it("refuses what isn't an amount", () => {
    for (const bad of ["", "  ", "abc", "1.234", "12.3.4", "$", "1e3"]) expect(parseAmountCents(bad)).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads each format, and refuses impossible dates", () => {
    expect(parseDate("01/05/2025", "MM/DD/YYYY")).toBe("2025-01-05");
    expect(parseDate("05/01/2025", "DD/MM/YYYY")).toBe("2025-01-05");
    expect(parseDate("2025-01-05", "YYYY-MM-DD")).toBe("2025-01-05");
    expect(parseDate("1/5/25", "MM/DD/YY")).toBe("2025-01-05");
    expect(parseDate("2025-01-05 13:45:00", "YYYY-MM-DD")).toBe("2025-01-05");
    expect(parseDate("02/30/2025", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("13/01/2025", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("Pending", "MM/DD/YYYY")).toBeNull();
  });
});

describe("guessMapping", () => {
  it("finds date, description and a signed amount, and the date format", () => {
    const rows = readCsv("Posting Date,Description,Amount,Balance\n2025-01-05,LUMEN BISTRO,-42.10,900.00\n2025-01-06,PAYROLL,2000,2900");
    expect(guessMapping(rows)).toMatchObject({ date: 0, description: 1, dateFormat: "YYYY-MM-DD", amount: { kind: "signed", column: 2 } });
  });

  it("finds the header below an account summary", () => {
    const rows = readCsv("Account summary: Example Checking\nTransaction Date,Payee,Debit,Credit,Balance\n01/05/2025,LUMEN BISTRO,42.10,,900.00");
    expect(guessMapping(rows)).toMatchObject({ skipRows: 1, date: 0, description: 1, amount: { kind: "split", debit: 2, credit: 3 } });
  });

  it("finds separate debit and credit columns", () => {
    const rows = readCsv("Transaction Date,Payee,Debit,Credit\n01/05/2025,LUMEN BISTRO,42.10,\n01/06/2025,PAYROLL,,2000.00");
    expect(guessMapping(rows)).toMatchObject({ date: 0, description: 1, dateFormat: "MM/DD/YYYY", amount: { kind: "split", debit: 2, credit: 3 } });
  });
});

describe("applyMapping", () => {
  const signed: Mapping = { skipRows: 0, hasHeader: true, date: 0, dateFormat: "MM/DD/YYYY", description: 1, amount: { kind: "signed", column: 2, flip: false } };

  it("reads rows, numbering errors as in the file", () => {
    const rows = readCsv("Date,Description,Amount\n01/05/2025,LUMEN BISTRO,-42.10\nPending,CORNER BEAN CAFE,-4.50\n01/07/2025,,-1.00\n01/08/2025,QUILLFIELD MARKET,\n01/09/2025,BEGINNING BALANCE,0.00");
    const { rows: parsed, errors } = applyMapping(rows, signed);
    expect(parsed.map((r) => [r.row, r.postedOn, r.amountCents, r.description])).toEqual([[2, "2025-01-05", -4_210, "LUMEN BISTRO"]]);
    expect(errors).toEqual([
      { row: 3, message: 'Date "Pending" isn\'t MM/DD/YYYY' },
      { row: 4, message: "No description" },
      { row: 5, message: "No amount" },
      { row: 6, message: "Amount is zero" },
    ]);
  });

  it("makes money out negative from debit and credit columns, and flips a card's positive purchases", () => {
    const split = readCsv("Date,Payee,Debit,Credit\n01/05/2025,LUMEN BISTRO,42.10,\n01/06/2025,PAYROLL,,2000.00");
    const s = applyMapping(split, { ...signed, amount: { kind: "split", debit: 2, credit: 3 } });
    expect(s.rows.map((r) => r.amountCents)).toEqual([-4_210, 200_000]);
    // Some card exports show purchases as positive.
    const card = readCsv("Date,Description,Amount\n01/05/2025,LUMEN BISTRO,42.10\n01/09/2025,PAYMENT THANK YOU,-500.00");
    expect(applyMapping(card, { ...signed, amount: { kind: "signed", column: 2, flip: true } }).rows.map((r) => r.amountCents)).toEqual([-4_210, 50_000]);
  });

  it("skips summary lines above the header", () => {
    const rows = readCsv("Account: Example Checking\nExported 2025-02-01\nDate,Description,Amount\n01/05/2025,LUMEN BISTRO,-42.10");
    expect(applyMapping(rows, { ...signed, skipRows: 2 }).rows).toHaveLength(1);
  });

  it("gives each row a stable ID, so the same file twice is the same rows, and two identical purchases stay two", () => {
    const text = "Date,Description,Amount\n01/05/2025,CORNER BEAN CAFE,-4.50\n01/05/2025,CORNER BEAN CAFE,-4.50\n01/06/2025,CORNER BEAN CAFE,-4.50";
    const first = applyMapping(readCsv(text), signed).rows.map((r) => r.externalId);
    const again = applyMapping(readCsv(text), signed).rows.map((r) => r.externalId);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(first[0]).toMatch(/^csv:2025-01-05:-450:/);
  });
});

describe("findOverlaps", () => {
  const rows = applyMapping(
    readCsv("Date,Description,Amount\n01/05/2025,LUMEN BISTRO DOWNTOWN,-42.10\n01/05/2025,CORNER BEAN CAFE,-4.50\n01/20/2025,QUILLFIELD MARKET,-60.00"),
    { skipRows: 0, hasHeader: true, date: 0, dateFormat: "MM/DD/YYYY", description: 1, amount: { kind: "signed", column: 2, flip: false } },
  ).rows;

  it("matches the exact amount within a few days, closest first, each existing transaction once", () => {
    const existing = [
      { id: "s1", postedOn: "2025-01-07", amountCents: -4_210, description: "SQ *LUMEN BISTRO" },
      { id: "s2", postedOn: "2025-01-10", amountCents: -450, description: "CORNER BEAN CAFE" }, // 5 days: too far
      { id: "s3", postedOn: "2025-01-21", amountCents: -6_000, description: "QUILLFIELD MKT" },
      { id: "s4", postedOn: "2025-01-21", amountCents: -6_001, description: "QUILLFIELD MKT" }, // a cent off
    ];
    const overlaps = findOverlaps(rows, existing);
    expect([...overlaps].map(([row, e]) => [row, e.id])).toEqual([
      [2, "s1"],
      [4, "s3"],
    ]);
  });

  it("prefers the more similar description when two are equally close", () => {
    const existing = [
      { id: "other", postedOn: "2025-01-06", amountCents: -4_210, description: "ZIPRIDE TRIP" },
      { id: "same", postedOn: "2025-01-06", amountCents: -4_210, description: "LUMEN BISTRO" },
    ];
    expect(findOverlaps(rows, existing).get(2)!.id).toBe("same");
  });
});
