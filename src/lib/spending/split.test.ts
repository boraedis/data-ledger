import { describe, expect, it } from "vitest";
import type { Row } from "./analyze";
import { barShare, splitRows } from "./split";

// Made-up rows, already ranked as the table ranks them.
const row = (key: string, spentCents: number, prevCents: number): Row => ({ key, label: key, spentCents, prevCents, children: [] });

describe("splitRows", () => {
  it("keeps the biggest rows and sums the rest, scaled to the longest bar of either period", () => {
    const rows = [row("a", 5000, 9000), row("b", 3000, 0), row("c", 200, 100), row("d", 100, 300)];
    const s = splitRows(rows, 2);
    expect(s.shown.map((r) => r.key)).toEqual(["a", "b"]);
    expect(s.rest).toEqual({ count: 2, spentCents: 300, prevCents: 400 });
    expect(s.scaleCents).toBe(9000);
  });

  it("shows a lone leftover row rather than a line for one", () => {
    const s = splitRows([row("a", 3, 0), row("b", 2, 0), row("c", 1, 0)], 2);
    expect(s.shown).toHaveLength(3);
    expect(s.rest).toBeNull();
  });

  it("draws no bar below zero", () => {
    expect(barShare(-500, 1000)).toBe(0);
    expect(barShare(250, 1000)).toBe(0.25);
  });
});
