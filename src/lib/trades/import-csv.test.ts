import { describe, expect, it } from "vitest";
import { readCsv } from "@/lib/history/csv";
import {
  actionKey,
  applyBrokerageMapping,
  categoryFor,
  distinctActions,
  guessAction,
  guessBrokerageMapping,
  parseSignedDecimal,
  type BrokerageMapping,
} from "@/lib/trades/import-csv";

// Reading a brokerage export (#354), on two invented layouts with invented
// funds (ZZIX, ZQXV, ZMMF) and amounts. Neither is any real brokerage's.

// Layout A: an account summary above the header, actions as sentences with
// the symbol in them, a settlement date, signed quantities, a price column.
const LAYOUT_A = `Example Brokerage — Individual account
Activity export
Run Date,Action,Symbol,Security Description,Quantity,Price ($),Amount ($),Settlement Date
04/01/2026,YOU BOUGHT EXAMPLE INDEX FUND (ZZIX) (Cash),ZZIX,EXAMPLE INDEX FUND,5,100.00,-500.00,04/02/2026
04/03/2026,YOU SOLD EXAMPLE GROWTH FUND (ZQXV) (Cash),ZQXV,EXAMPLE GROWTH FUND,-2,50.25,100.50,04/06/2026
04/10/2026,DIVIDEND RECEIVED EXAMPLE INDEX FUND (ZZIX) (Cash),ZZIX,EXAMPLE INDEX FUND,,,12.00,
04/10/2026,REINVESTMENT EXAMPLE INDEX FUND (ZZIX) (Cash),ZZIX,EXAMPLE INDEX FUND,0.1,120.00,-12.00,
04/15/2026,ELECTRONIC FUNDS TRANSFER RECEIVED (Cash),,No Description,,,"1,000.00",
04/20/2026,"STOCK SPLIT EXAMPLE GROWTH FUND (ZQXV)",ZQXV,EXAMPLE GROWTH FUND,3,,,
04/21/2026,YOU BOUGHT EXAMPLE INDEX FUND (ZZIX) (Cash),ZZIX,EXAMPLE INDEX FUND,5,100.00,-500.00,04/22/2026
04/21/2026,YOU BOUGHT EXAMPLE INDEX FUND (ZZIX) (Cash),ZZIX,EXAMPLE INDEX FUND,5,100.00,-500.00,04/22/2026
04/30/2026,REINVESTMENT CASH SWEEP (ZMMF),ZMMF,EXAMPLE MONEY MARKET,10,1,-10.00,
`;

// Layout B: ISO dates, a short type column, no price, quantities unsigned.
const LAYOUT_B = `Date,Type,Ticker,Shares,Net Amount,Memo
2026-05-01,Buy,zzix,2.5,"(250.00)",Monthly buy
2026-05-02,Sell,ZQXV,1,49.00,
2026-05-03,Interest,,,0.42,Cash interest
2026-05-04,Shares Received,ZQXV,4,,From another account
2026-05-05,Fee,,,-1.50,Account fee
2026-05-06,Buy,,3,-30.00,
2026-05-07,Mystery,ZZIX,1,-1.00,
`;

const confirmAll = (m: BrokerageMapping, extra: Record<string, BrokerageMapping["actions"][string]> = {}) => ({ ...m, actions: { ...m.actions, ...extra } });

describe("action keys and guesses", () => {
  it("drop what varies row to row, so one fund's buys are one action", () => {
    expect(actionKey("YOU BOUGHT EXAMPLE INDEX FUND (ZZIX) (Cash)")).toBe("YOU BOUGHT EXAMPLE INDEX FUND");
    expect(actionKey("  you  bought 5 sh @ $100.00 ")).toBe("YOU BOUGHT SH @");
  });

  it("guess common words, reinvestment before dividend, and nothing for what doesn't read", () => {
    expect(guessAction("DIVIDEND REINVESTMENT")).toBe("reinvest");
    expect(guessAction("DIVIDEND RECEIVED")).toBe("income");
    expect(guessAction("YOU BOUGHT")).toBe("buy");
    expect(guessAction("YOU SOLD")).toBe("sell");
    expect(guessAction("STOCK SPLIT")).toBe("split");
    expect(guessAction("SHARES RECEIVED")).toBe("shares_in");
    expect(guessAction("TRANSFER RECEIVED")).toBe("cash");
    expect(guessAction("MYSTERY")).toBeNull();
  });

  it("let one mapped prefix cover every fund, the longest winning", () => {
    const actions = { "YOU BOUGHT": "buy", "YOU BOUGHT CASH": "ignore" } as const;
    expect(categoryFor("YOU BOUGHT EXAMPLE INDEX FUND", actions)).toBe("buy");
    expect(categoryFor("YOU BOUGHT CASH SWEEP", actions)).toBe("ignore");
    expect(categoryFor("YOU SOLD", actions)).toBeNull();
  });

  it("read signed decimals exactly", () => {
    expect(parseSignedDecimal("-2")).toEqual({ value: "2", negative: true });
    expect(parseSignedDecimal("(1,234.50)")).toEqual({ value: "1234.5", negative: true });
    expect(parseSignedDecimal("$0.00012345")).toEqual({ value: "0.00012345", negative: false });
    expect(parseSignedDecimal("n/a")).toBeNull();
  });
});

describe("layout A", () => {
  const all = readCsv(LAYOUT_A);
  const guessed = guessBrokerageMapping(all);

  it("is guessed: summary skipped, every column found, settlement apart from the trade date", () => {
    expect(guessed).toMatchObject({ skipRows: 2, dateFormat: "MM/DD/YYYY", date: 0, action: 1, symbol: 2, description: 3, quantity: 4, price: 5, amount: 6, settleDate: 7 });
    expect(distinctActions(all, guessed)[0]).toBe("YOU BOUGHT EXAMPLE INDEX FUND");
    expect(guessed.actions["STOCK SPLIT EXAMPLE GROWTH FUND"]).toBe("split");
  });

  it("gives each row its cash and its shares", () => {
    // The sweep into the money market fund is the owner's to ignore.
    const { rows, errors } = applyBrokerageMapping(all, confirmAll(guessed, { "REINVESTMENT CASH SWEEP": "ignore" }));
    expect(errors).toEqual([]);
    const at = (row: number) => rows.find((r) => r.row === row)!;

    // A buy: shares on the trade date, cash on the settlement date.
    expect(at(4)).toMatchObject({
      category: "buy",
      trade: { on: "2026-04-01", kind: "trade", side: "buy", symbol: "ZZIX", quantity: "5", price: "100" },
      cash: { postedOn: "2026-04-02", amountCents: -50_000 },
    });
    // A sell's quantity is written negative; the trade's is positive.
    expect(at(5).trade).toMatchObject({ side: "sell", quantity: "2", price: "50.25" });
    expect(at(5).cash?.amountCents).toBe(10_050);
    // The dividend is cash in; its reinvestment is shares bought and the cash that left.
    expect(at(6)).toMatchObject({ category: "income", trade: null, cash: { amountCents: 1_200, postedOn: "2026-04-10" } });
    expect(at(7)).toMatchObject({ category: "reinvest", trade: { kind: "reinvestment", side: "buy", quantity: "0.1" }, cash: { amountCents: -1_200 } });
    // A deposit is cash only.
    expect(at(8)).toMatchObject({ category: "cash", trade: null, cash: { amountCents: 100_000 } });
    // A split is shares only, with no price.
    expect(at(9)).toMatchObject({ category: "split", cash: null, trade: { kind: "split", side: "buy", quantity: "3", price: null } });
    // Ignored rows aren't there and aren't errors.
    expect(rows.some((r) => r.row === 12)).toBe(false);
  });

  it("gives stable IDs: the same file twice matches, and two identical buys stay two", () => {
    const mapping = confirmAll(guessed, { "REINVESTMENT CASH SWEEP": "ignore" });
    const once = applyBrokerageMapping(all, mapping).rows.map((r) => r.id);
    const again = applyBrokerageMapping(readCsv(LAYOUT_A), mapping).rows.map((r) => r.id);
    expect(again).toEqual(once);
    expect(new Set(once).size).toBe(once.length);
    const twins = applyBrokerageMapping(all, mapping).rows.filter((r) => r.trade?.on === "2026-04-21");
    expect(twins).toHaveLength(2);
    expect(twins[0].id).not.toBe(twins[1].id);
  });
});

describe("layout B", () => {
  const all = readCsv(LAYOUT_B);
  const guessed = guessBrokerageMapping(all);

  it("is guessed with ISO dates, no price column and no settlement date", () => {
    expect(guessed).toMatchObject({ skipRows: 0, dateFormat: "YYYY-MM-DD", date: 0, action: 1, symbol: 2, quantity: 3, amount: 4, price: null, settleDate: null, description: 5 });
  });

  it("prices a trade from its cash, takes shares moved in without cash, and reports what it can't read", () => {
    const { rows, errors } = applyBrokerageMapping(all, guessed);
    const at = (row: number) => rows.find((r) => r.row === row);
    expect(at(2)).toMatchObject({ trade: { symbol: "ZZIX", quantity: "2.5", price: "100" }, cash: { amountCents: -25_000, description: "Buy Monthly buy" } });
    expect(at(3)?.trade?.price).toBe("49");
    expect(at(4)).toMatchObject({ category: "income", cash: { amountCents: 42 } });
    expect(at(5)).toMatchObject({ category: "shares_in", cash: null, trade: { kind: "transfer", side: "transfer_in", quantity: "4", price: null } });
    expect(at(6)).toMatchObject({ category: "cash", cash: { amountCents: -150 } });
    expect(errors).toEqual([
      { row: 7, message: "Buy with no symbol" },
      { row: 8, message: `"MYSTERY" isn't mapped to an action yet` },
    ]);
  });

  it("errors on a cash-only row with no amount and a trade with no quantity", () => {
    const broken = readCsv(`Date,Type,Ticker,Shares,Net Amount\n2026-05-03,Interest,,,\n2026-05-04,Buy,ZZIX,,-10.00\n2026-05-05,Buy,ZZIX,1,\n`);
    const { rows, errors } = applyBrokerageMapping(broken, guessBrokerageMapping(broken));
    expect(errors).toEqual([
      { row: 2, message: "No amount" },
      { row: 3, message: "Buy of ZZIX with no quantity" },
    ]);
    // A buy with its amount left blank is still its shares, with no cash and no price.
    expect(rows).toMatchObject([{ row: 4, cash: null, trade: { quantity: "1", price: null } }]);
  });
});
