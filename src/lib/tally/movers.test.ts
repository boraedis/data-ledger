import { describe, expect, it } from "vitest";
import { investmentMoves, investmentsText, type HoldingRow } from "./movers";

// Investment moves for Tally's summary (#214). Holdings and values invented.

const row = (externalId: string, shares: string, marketValueCents: number, symbol: string | null = externalId): HoldingRow => ({
  accountName: "Index Fund Account",
  externalId,
  symbol,
  description: `${externalId} fund`,
  shares,
  marketValueCents,
});

describe("investmentMoves (#214)", () => {
  it("calls out a holding that moved 8% in a day, and not a small move", () => {
    const moves = investmentMoves(
      { on: "2026-06-29", rows: [row("ZQX", "10", 100_000), row("BLND", "100", 500_000)] },
      { on: "2026-06-30", rows: [row("ZQX", "10", 108_000), row("BLND", "100", 505_000)] },
    )!;
    expect(moves.movers.map((m) => m.label)).toEqual(["ZQX (Index Fund Account)"]);
    expect(moves.movers[0].changePct).toBeCloseTo(8);
    expect(moves.changePct).toBeCloseTo(((108_000 + 505_000) / 600_000 - 1) * 100);
    expect(investmentsText(moves)).toBe("- Investments since 2026-06-29: holdings up 2.2%.\n- Big movers: ZQX (Index Fund Account) up 8.0%.");
  });

  it("judges by price, so buying more isn't a move", () => {
    const moves = investmentMoves({ on: "2026-06-29", rows: [row("ZQX", "10", 100_000)] }, { on: "2026-06-30", rows: [row("ZQX", "20", 200_000)] })!;
    expect(moves.movers).toEqual([]);
    expect(investmentsText(moves)).toBe("- Investments since 2026-06-29: holdings about flat.");
  });

  it("leaves out a position on only one of the days, and needs one on both", () => {
    expect(investmentMoves({ on: "2026-06-29", rows: [row("OLD", "1", 1_000)] }, { on: "2026-06-30", rows: [row("NEW", "1", 9_000)] })).toBeNull();
    const down = investmentMoves(
      { on: "2026-06-29", rows: [row("ZQX", "10", 100_000), row("OLD", "1", 1_000)] },
      { on: "2026-06-30", rows: [row("ZQX", "10", 91_000), row("NEW", "1", 9_000)] },
    )!;
    expect(investmentsText(down)).toBe("- Investments since 2026-06-29: holdings down 9.0%.\n- Big movers: ZQX (Index Fund Account) down 9.0%.");
  });
});
