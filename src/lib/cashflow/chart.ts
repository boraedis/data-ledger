// The shaded gap between cash in and cash out on the Cash flow line
// charts (#171): one band per stretch where one side stays ahead, split
// where the lines cross, so a band is all "in ahead" (net positive) or all
// "out ahead". Points are at whole indexes; a crossing lands between them.
// Client-safe and pure.

export type Band = { ahead: "in" | "out"; points: { x: number; inCents: number; outCents: number }[] };

export function netBands(series: { inCents: number; outCents: number }[]): Band[] {
  const bands: Band[] = [];
  const sign = (p: { inCents: number; outCents: number }) => Math.sign(p.inCents - p.outCents);
  let current: Band | null = null;
  const push = (x: number, inCents: number, outCents: number, ahead: "in" | "out") => {
    if (!current || current.ahead !== ahead) {
      const start: Band = { ahead, points: current ? [current.points.at(-1)!] : [] };
      current = start;
      bands.push(start);
    }
    current.points.push({ x, inCents, outCents });
  };
  series.forEach((p, i) => {
    const prev = series[i - 1];
    if (prev && sign(prev) !== 0 && sign(p) !== 0 && sign(prev) !== sign(p)) {
      // Where the lines cross: both at the same value, part way between.
      const d0 = prev.inCents - prev.outCents;
      const d1 = p.inCents - p.outCents;
      const t = d0 / (d0 - d1);
      const at = prev.inCents + (p.inCents - prev.inCents) * t;
      push(i - 1 + t, at, at, sign(prev) > 0 ? "in" : "out");
    }
    const s = sign(p);
    push(i, p.inCents, p.outCents, s > 0 ? "in" : s < 0 ? "out" : (current?.ahead ?? "in"));
  });
  // A band needs two points to enclose anything.
  return bands.filter((b) => b.points.length > 1);
}
