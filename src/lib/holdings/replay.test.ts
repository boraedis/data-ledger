import { describe, expect, it } from "vitest";
import { difference, firstShortfall, holdingsOn, type Trade } from "./replay";

// Replaying trades (#247). Symbols and quantities invented.

const trades: Trade[] = [
  { on: "2026-03-01", symbol: "ZZIX", side: "buy", quantity: "10" },
  { on: "2026-04-15", symbol: "ZZIX", side: "buy", quantity: "2.5" },
  { on: "2026-05-01", symbol: "ZZIX", side: "sell", quantity: "4.25" },
  { on: "2026-04-01", symbol: "ZQC", side: "transfer_in", quantity: "0.1" },
  { on: "2026-06-01", symbol: "ZQC", side: "transfer_out", quantity: "0.1" },
];

describe("holdingsOn (#247)", () => {
  it("gives the quantity on each day between two buys and a sell", () => {
    expect(holdingsOn(trades, "2026-02-28").get("ZZIX")).toBeUndefined();
    expect(holdingsOn(trades, "2026-03-01").get("ZZIX")).toBe("10");
    expect(holdingsOn(trades, "2026-04-30").get("ZZIX")).toBe("12.5");
    expect(holdingsOn(trades, "2026-05-01").get("ZZIX")).toBe("8.25");
  });

  it("counts transfers, and leaves out what's back at zero", () => {
    expect(holdingsOn(trades, "2026-04-02").get("ZQC")).toBe("0.1");
    expect([...holdingsOn(trades).entries()]).toEqual([["ZZIX", "8.25"]]);
  });

  it("is exact where floats aren't", () => {
    const tiny: Trade[] = [
      { on: "2026-01-01", symbol: "ZQC", side: "buy", quantity: "0.1" },
      { on: "2026-01-02", symbol: "ZQC", side: "buy", quantity: "0.2" },
    ];
    expect(holdingsOn(tiny).get("ZQC")).toBe("0.3");
    expect(difference("0.3", "0.1")).toBe("0.2");
    expect(difference("1", "1.5")).toBe("-0.5");
  });
});

describe("firstShortfall", () => {
  it("finds selling more than was held, in date order", () => {
    expect(firstShortfall(trades)).toBeNull();
    expect(firstShortfall([...trades, { on: "2026-05-02", symbol: "ZZIX", side: "sell", quantity: "9" }])).toEqual({ symbol: "ZZIX", on: "2026-05-02", quantity: "-0.75" });
    // A sell dated before its buy is short on that day, whatever order they were entered in.
    expect(firstShortfall([{ on: "2026-01-02", symbol: "A", side: "buy", quantity: "1" }, { on: "2026-01-01", symbol: "A", side: "sell", quantity: "1" }])).toMatchObject({ on: "2026-01-01" });
  });
});
