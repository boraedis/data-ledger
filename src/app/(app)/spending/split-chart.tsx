import Link from "next/link";
import type { Row } from "@/lib/spending/analyze";
import { barShare, splitRows } from "@/lib/spending/split";
import { formatCents } from "@/lib/money";

// The split (#265): the grouping's biggest rows, this period's bar over the
// last period's lighter one, on one scale, each labelled with its amount.
// Plain HTML rather than a drawing: every row is a link to the same
// selection the table's row opens, and its words (name, both amounts) are
// the text alternative, so nothing rests on the bars or their colour.
// Server-rendered.

export function SplitChart({ rows, label, prevLabel, hrefFor }: { rows: Row[]; label: string; prevLabel: string; hrefFor: (key: string) => string }) {
  const { shown, rest, scaleCents } = splitRows(rows);
  const bars = (spent: number, prev: number) => (
    <span className="col-span-2 space-y-0.5" aria-hidden>
      <span className="block h-2 rounded-sm bg-primary" style={{ width: `${barShare(spent, scaleCents) * 100}%` }} />
      <span className="block h-1.5 rounded-sm bg-primary/30" style={{ width: `${barShare(prev, scaleCents) * 100}%` }} />
    </span>
  );
  const amounts = (spent: number, prev: number) => (
    <span className="text-right tabular-nums">
      {formatCents(spent)} <span className="text-xs text-muted-foreground">was {formatCents(prev)}</span>
    </span>
  );
  return (
    <section aria-label={`The split, ${label} against ${prevLabel}`} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1">
          <span className="h-2 w-4 rounded-sm bg-primary" />
          {label}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-4 rounded-sm bg-primary/30" />
          {prevLabel} (was)
        </span>
      </div>
      <ul className="space-y-1.5 text-sm">
        {shown.map((r) => (
          <li key={r.key}>
            <Link
              href={hrefFor(r.key)}
              aria-label={`${r.label}: ${formatCents(r.spentCents)} in ${label}, ${formatCents(r.prevCents)} in ${prevLabel}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded px-1 py-0.5 hover:bg-muted/50"
            >
              <span className="truncate">{r.label}</span>
              {amounts(r.spentCents, r.prevCents)}
              {bars(r.spentCents, r.prevCents)}
            </Link>
          </li>
        ))}
        {rest ? (
          <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-1 py-0.5 text-muted-foreground">
            <span className="truncate">{rest.count} more, together</span>
            <span className="sr-only">{`${formatCents(rest.spentCents)} in ${label}, ${formatCents(rest.prevCents)} in ${prevLabel}`}</span>
            <span aria-hidden className="contents">
              {amounts(rest.spentCents, rest.prevCents)}
            </span>
            {bars(rest.spentCents, rest.prevCents)}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
