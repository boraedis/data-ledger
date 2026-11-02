import { describe, expect, it } from "vitest";
import { netBands } from "./chart";

const p = (inCents: number, outCents: number) => ({ inCents, outCents });

describe("netBands (#171)", () => {
  it("keeps one band while the same side stays ahead", () => {
    const bands = netBands([p(300, 100), p(300, 200), p(400, 100)]);
    expect(bands).toHaveLength(1);
    expect(bands[0].ahead).toBe("in");
    expect(bands[0].points.map((x) => x.x)).toEqual([0, 1, 2]);
  });

  it("splits where the lines cross, both bands meeting at the crossing", () => {
    // In 300 → 100, out 100 → 300: they cross half way, at 200.
    const bands = netBands([p(300, 100), p(100, 300)]);
    expect(bands.map((b) => b.ahead)).toEqual(["in", "out"]);
    expect(bands[0].points.at(-1)).toEqual({ x: 0.5, inCents: 200, outCents: 200 });
    expect(bands[1].points[0]).toEqual({ x: 0.5, inCents: 200, outCents: 200 });
  });

  it("carries a tie into the band it's in, and draws nothing for one point", () => {
    expect(netBands([p(300, 100), p(200, 200), p(300, 100)]).map((b) => b.ahead)).toEqual(["in"]);
    expect(netBands([p(300, 100)])).toEqual([]);
  });
});
