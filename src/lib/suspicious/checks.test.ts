import { describe, expect, it } from "vitest";
import { NEW_MERCHANT_MIN_CENTS, flagsFor, newMerchantBar, type Charge, type Context, type Verdict } from "@/lib/suspicious/checks";

// Invented merchants, accounts and amounts. amountCents > 0 = spent.

let n = 0;
const c = (merchant: string | null, date: string, dollars: number, extra: Partial<Charge> = {}): Charge => ({
  id: `t${String(++n).padStart(3, "0")}`,
  accountId: "card",
  merchant,
  description: merchant ?? "",
  date,
  amountCents: Math.round(dollars * 100),
  categoryId: null,
  provisional: false,
  manual: false,
  ...extra,
});

function ctx(charges: Charge[], verdicts: Verdict[] = []): Context {
  const byMerchant = new Map<string, Charge[]>();
  const byCategory = new Map<string, Charge[]>();
  for (const ch of charges) {
    if (ch.merchant) byMerchant.set(ch.merchant, [...(byMerchant.get(ch.merchant) ?? []), ch]);
    if (ch.categoryId) byCategory.set(ch.categoryId, [...(byCategory.get(ch.categoryId) ?? []), ch]);
  }
  const earliest = new Map<string, { id: string; date: string }[]>();
  for (const [m, list] of byMerchant) {
    earliest.set(
      m,
      list
        .filter((x) => !x.provisional)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
        .slice(0, 2)
        .map((x) => ({ id: x.id, date: x.date })),
    );
  }
  return { byMerchant, byCategory, earliest, verdicts, accountName: () => "Everyday Card", categoryName: () => "Dining" };
}

const grocer = (dates: string[], dollars: number) => dates.map((d) => c("Quillfield Market", d, dollars));
const SPRING = ["2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10"];
const fine = (kind: Verdict["kind"], merchant: string, dollars: number, day: number): Verdict => ({
  kind,
  merchant,
  amountCents: dollars * 100,
  verdict: "fine",
  at: new Date(Date.UTC(2026, 5, day)),
});

describe("unusually large", () => {
  it("flags a charge several times the merchant's usual and above its most, and says so in one line", () => {
    const big = c("Quillfield Market", "2026-06-12", 240);
    const [flag] = flagsFor([big], ctx([...grocer(SPRING, 45), big]));
    expect(flag).toMatchObject({ kind: "unusual_amount", transactionId: big.id, dedupeKey: `unusual_amount|${big.id}`, amountCents: 24_000 });
    expect(flag.title).toBe("$240.00 at Quillfield Market, about 5× usual");
    expect(flag.detail).toContain("Usually about $45.00 at Quillfield Market");
  });

  it("leaves alone a charge that's big only in multiples, or no bigger than one before", () => {
    // $4 → $13: three times, but $9 over.
    const coffee = c("Corner Bean", "2026-06-12", 13);
    expect(flagsFor([coffee], ctx([...SPRING.map((d) => c("Corner Bean", d, 4)), coffee]))).toEqual([]);
    // As large as the biggest so far isn't news.
    const history = [...grocer(SPRING, 45), c("Quillfield Market", "2026-01-15", 240)];
    const again = c("Quillfield Market", "2026-06-12", 240);
    expect(flagsFor([again], ctx([...history, again]))).toEqual([]);
  });

  it("falls back to the category for a merchant too new to have a usual", () => {
    const dinners = Array.from({ length: 10 }, (_, i) => c(`Bistro ${i}`, `2026-0${(i % 5) + 1}-0${(i % 9) + 1}`, 40, { categoryId: "dining" }));
    const feast = c("Saltmarsh Grill", "2026-06-12", 400, { categoryId: "dining" });
    const [flag] = flagsFor([feast], ctx([...dinners, c("Saltmarsh Grill", "2026-01-02", 30), feast]));
    expect(flag).toMatchObject({ kind: "unusual_amount" });
    expect(flag.detail).toContain("for Dining");
  });

  it("once the owner says an amount is fine there, flags only what's more than a quarter above it", () => {
    const history = grocer(SPRING, 45);
    const verdicts = [fine("unusual_amount", "Quillfield Market", 240, 1)];
    const near = c("Quillfield Market", "2026-06-12", 290);
    expect(flagsFor([near], ctx([...history, near], verdicts))).toEqual([]);
    const far = c("Quillfield Market", "2026-06-12", 320);
    expect(flagsFor([far], ctx([...history, far], verdicts))[0]?.kind).toBe("unusual_amount");
  });
});

describe("first-time merchant", () => {
  it("flags a merchant never seen before at the threshold or above, and nothing below it", () => {
    const big = c("Velvet Lane Outfitters", "2026-06-12", 320);
    expect(flagsFor([big], ctx([big]))[0]).toMatchObject({ kind: "new_merchant", title: "First charge from Velvet Lane Outfitters: $320.00" });
    const small = c("Velvet Lane Outfitters", "2026-06-12", 150);
    expect(flagsFor([small], ctx([small]))).toEqual([]);
  });

  it("isn't new once anything came from it before, but its own purchase-alert copy doesn't count", () => {
    const old = c("Velvet Lane Outfitters", "2025-11-02", 20);
    const big = c("Velvet Lane Outfitters", "2026-06-12", 320);
    expect(flagsFor([big], ctx([old, big]))).toEqual([]);
    const alertCopy = c("Velvet Lane Outfitters", "2026-06-11", 320, { provisional: true });
    expect(flagsFor([big], ctx([alertCopy, big]))[0]?.kind).toBe("new_merchant");
  });

  it("raises the bar to the median of three fine answers in a row, and resets after a suspicious one", () => {
    expect(newMerchantBar([])).toBe(NEW_MERCHANT_MIN_CENTS);
    const three = [fine("new_merchant", "A", 300, 1), fine("new_merchant", "B", 500, 2), fine("new_merchant", "C", 900, 3)];
    expect(newMerchantBar(three.slice(0, 2))).toBe(NEW_MERCHANT_MIN_CENTS);
    expect(newMerchantBar(three)).toBe(500_00);
    const flagged: Verdict = { ...fine("new_merchant", "D", 250, 4), verdict: "suspicious" };
    expect(newMerchantBar([...three, flagged])).toBe(NEW_MERCHANT_MIN_CENTS);

    const mid = c("Harbor Looms", "2026-06-12", 400);
    expect(flagsFor([mid], ctx([mid], three))).toEqual([]);
  });
});

describe("possible duplicate", () => {
  it("flags the second of two same-amount charges a day apart, once", () => {
    const first = c("Lantern Books", "2026-06-11", 38.5);
    const second = c("Lantern Books", "2026-06-12", 38.5);
    const flags = flagsFor([first, second], ctx([first, second]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "possible_duplicate", transactionId: second.id, title: "Lantern Books charged $38.50 twice" });
  });

  it("ignores small repeats, other accounts, different amounts, and the owner's own or an alert's copy", () => {
    const pair = (extra: Partial<Charge>, dollars = 38.5) => {
      const a = c("Lantern Books", "2026-06-11", 38.5);
      const b = c("Lantern Books", "2026-06-12", dollars, extra);
      return flagsFor([b], ctx([a, b])).filter((f) => f.kind === "possible_duplicate");
    };
    expect(pair({ accountId: "checking" })).toEqual([]);
    expect(pair({}, 38.75)).toEqual([]);
    expect(pair({ manual: true })).toEqual([]);
    expect(pair({ provisional: true })).toEqual([]);
    const coffee = [c("Corner Bean", "2026-06-12", 4.5), c("Corner Bean", "2026-06-12", 4.5)];
    expect(flagsFor(coffee, ctx(coffee))).toEqual([]);
  });

  it("stops asking about a merchant once a repeat there was called fine", () => {
    const pair = [c("Lantern Books", "2026-06-11", 38.5), c("Lantern Books", "2026-06-12", 38.5)];
    expect(flagsFor(pair, ctx(pair, [fine("possible_duplicate", "Lantern Books", 38.5, 1)]))).toEqual([]);
  });
});

describe("foreign transaction fee", () => {
  it("flags the issuer's fee line, before anything else about it", () => {
    const fee = c(null, "2026-06-12", 3.12, { description: "FOREIGN TRANSACTION FEE" });
    const [flag] = flagsFor([fee], ctx([fee]));
    expect(flag).toMatchObject({ kind: "foreign_fee", merchant: "FOREIGN TRANSACTION FEE", title: "Foreign transaction fee: $3.12" });
    expect(flagsFor([c(null, "2026-06-12", 3, { description: "INTL TRANSACTION FEE" })], ctx([]))[0]?.kind).toBe("foreign_fee");
    expect(flagsFor([c("Foreign Films Club", "2026-06-12", 12)], ctx([]))).toEqual([]);
  });
});
