import { describe, expect, it } from "vitest";
import { fit, planCash, priceFrom, quantityIn, recognize, symbolIn, type DraftForCash, type Recognized } from "@/lib/trades/cash-rows";

// Matching brokerage cash rows to draft trades (#321). Invented symbols and amounts.

const row = (id: string, postedOn: string, amountCents: number, text: string) => ({ id, accountId: "a1", postedOn, amountCents, text });
const draft = (id: string, extra: Partial<DraftForCash> = {}): DraftForCash => ({ id, accountId: "a1", side: "buy", symbol: "ZQXV", quantity: "2", on: "2026-05-05", onFrom: "2026-05-02", ...extra });
const at125 = () => 125;
const noPrice = () => null;

describe("recognize", () => {
  it("knows buys and sells by their words and the direction of the money", () => {
    expect(recognize(row("r", "2026-05-04", -25_000, "YOU BOUGHT ZQXV 2 SHARES @ 125.00"))).toMatchObject({ side: "buy", symbol: "ZQXV", quantity: "2" });
    expect(recognize(row("r", "2026-05-04", 25_000, "SOLD ZQXV"))).toMatchObject({ side: "sell", symbol: "ZQXV", quantity: null });
    // A reinvestment is a buy the dividend paid for (#324); the dividend itself is income.
    expect(recognize(row("r", "2026-05-04", -1_200, "DIVIDEND REINVESTMENT ZQXV"))).toMatchObject({ side: "buy", reinvestment: true });
    expect(recognize(row("r", "2026-05-04", 4_200, "DIVIDEND RECEIVED"))).toBeNull();
    // Words and money disagreeing is something else (a correction, a reversal): not a trade to match.
    expect(recognize(row("r", "2026-05-04", 25_000, "BUY ZQXV"))).toBeNull();
  });

  it("reads a symbol and quantity only when the text carries them", () => {
    expect(symbolIn("BUY Example Growth Fund")).toBeNull();
    expect(symbolIn("PURCHASE ZZ.B")).toBe("ZZ.B");
    expect(quantityIn("bought 1,250.500 sh")).toBe("1250.5");
    expect(quantityIn("BUY ZQXV 0.25 @ 125")).toBe("0.25");
    expect(quantityIn("BUY ZQXV")).toBeNull();
    expect(priceFrom(-25_000, "2")).toBe("125");
    expect(priceFrom(-10_000, "3")).toBe("33.3333");
  });
});

describe("fit", () => {
  const buy = recognize(row("r", "2026-05-04", -25_000, "BUY ZQXV"))!;

  it("fits on amount when the day's price is known, within a commission", () => {
    expect(fit(buy, draft("d"), at125)).toBe("amount");
    expect(fit({ ...buy, amountCents: -25_900 }, draft("d"), at125)).toBe("amount");
    expect(fit({ ...buy, amountCents: -40_000 }, draft("d"), at125)).toBeNull();
  });

  it("falls back to the symbol with no price, and needs the day, side and account to fit", () => {
    expect(fit(buy, draft("d"), noPrice)).toBe("symbol");
    expect(fit({ ...buy, symbol: null }, draft("d"), noPrice)).toBeNull();
    expect(fit(buy, draft("d", { side: "sell" }), at125)).toBeNull();
    expect(fit(buy, draft("d", { accountId: "a2" }), at125)).toBeNull();
    // Settlement days either side of the range.
    expect(fit({ ...buy, postedOn: "2026-05-08" }, draft("d"), at125)).toBe("amount");
    expect(fit({ ...buy, postedOn: "2026-05-09" }, draft("d"), at125)).toBeNull();
    expect(fit({ ...buy, postedOn: "2026-04-29" }, draft("d"), at125)).toBe("amount");
  });
});

describe("planCash", () => {
  const r1 = recognize(row("r1", "2026-05-04", -25_000, "BUY ZQXV"))! as Recognized;
  const r2 = recognize(row("r2", "2026-05-03", -25_100, "BUY ZQXV"))! as Recognized;
  const stray = recognize(row("r3", "2026-05-20", -9_000, "BUY ZZIX"))! as Recognized;

  it("attaches a row and draft that are each other's one fit, and leaves the rest as hints", () => {
    const plan = planCash([r1, stray], [draft("d")], at125);
    expect(plan.attach).toEqual([{ tradeId: "d", transactionId: "r1" }]);
    expect(plan.offers.size).toBe(0);
    expect(plan.hints.map((h) => h.id)).toEqual(["r3"]);
  });

  it("offers instead of attaching when two rows could be one draft", () => {
    const plan = planCash([r1, r2], [draft("d")], at125);
    expect(plan.attach).toEqual([]);
    expect(plan.offers.get("d")?.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(plan.hints).toEqual([]);
  });
});
