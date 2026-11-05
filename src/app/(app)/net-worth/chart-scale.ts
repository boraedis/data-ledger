import { formatCents } from "@/lib/money";

// Scale and labels shared by the Over time charts: daily (./history.tsx) and hourly (./hourly-chart.tsx).

export const HEIGHT = 240;
export const PAD = { top: 10, right: 8, bottom: 22, left: 8 };

export function niceStep(span: number, ticks: number) {
  const raw = span / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
}

export function compact(cents: number) {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "−" : "";
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

export const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatCents(Math.abs(cents))}`;
