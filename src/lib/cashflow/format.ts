// Cash flow's percent view (#62): a flow as a share of all the period's
// money in. Shared by the page (a server component) and the chart.

/** A share of the period's money in: one decimal under 10%, so small flows aren't all "0%". */
export function formatShare(cents: number, ofCents: number): string {
  if (ofCents <= 0) return "—";
  const pct = (cents / ofCents) * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}
