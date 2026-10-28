// A trend line with no axes, for a dashboard card (#71): the shape of the
// last few months at a glance; the full chart is a tap away. Server-rendered
// SVG, no JavaScript. Draws in the accent, like the full chart.
export function Sparkline({ values, label, className = "h-10 w-full" }: { values: number[]; label: string; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(28 - ((v - min) / span) * 26).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className} role="img" aria-label={label}>
      <polyline points={points} fill="none" className="stroke-primary" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
