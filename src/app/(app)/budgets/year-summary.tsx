import Link from "next/link";
import { formatCents } from "@/lib/money";
import { PaceBar } from "./pace-bar";

// The calendar year across every target (#123): each target's year (its
// periods' targets at the version each had, and spending so far) and the
// total. Each row opens that target's row in the Year view. Server-rendered.
//
// Bars split yellow then red when over (#159), but carry no pace: a row is
// several periods (an annual target, a monthly one twelve times, one that
// started in October), so a straight line across the calendar year would
// call a new target "within pace" when it isn't. Each card has the pace.

type Row = { categoryId: string | null; name: string; targetCents: number; spentCents: number; remainingCents: number };

function Line({ name, spentCents, targetCents, remainingCents, href, strong = false }: Omit<Row, "categoryId"> & { href?: string; strong?: boolean }) {
  const over = remainingCents < 0;
  const body = (
    <>
      <span className="truncate">{name}</span>
      <span className="text-right tabular-nums">
        {formatCents(spentCents)} <span className="font-normal text-muted-foreground">of {formatCents(targetCents)}</span>
      </span>
      <PaceBar spentCents={spentCents} budgetCents={targetCents} paceCents={null} className="h-1.5" rounded="rounded-full" />
      <span className={`text-right text-xs tabular-nums ${over ? "font-medium text-negative" : "font-normal text-muted-foreground"}`}>
        {over ? `${formatCents(-remainingCents)} over` : `${formatCents(remainingCents)} left`}
      </span>
    </>
  );
  const cls = `grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 ${strong ? "bg-muted/40 font-medium" : ""}`;
  return <li>{href ? <Link href={href} className={`${cls} hover:bg-muted/50`}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
}

export function YearSummary({
  year,
  targets,
  total,
  isThisYear,
  yearHref,
  detailHref,
}: {
  year: number;
  targets: Row[];
  total: { targetCents: number; spentCents: number; remainingCents: number };
  isThisYear: boolean;
  yearHref: (year: number) => string;
  detailHref: (categoryId: string | null) => string;
}) {
  return (
    <section className="space-y-2" id="year">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{year} across every target</h2>
        <nav className="flex gap-3 text-sm">
          <Link href={yearHref(year - 1)} className="text-muted-foreground hover:text-foreground">
            ← {year - 1}
          </Link>
          {isThisYear ? null : (
            <Link href={yearHref(year + 1)} className="text-muted-foreground hover:text-foreground">
              {year + 1} →
            </Link>
          )}
        </nav>
      </div>
      <p className="text-xs text-muted-foreground">
        Each target&apos;s periods in {year}, at the target each period had, against spending
        {isThisYear ? " so far; the rest of the year's periods count in full" : ""}. A target that ended counts for the periods it covered; an
        annual one that starts mid-year counts the months of it that fall in {year}.
      </p>
      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No targets in {year}.</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {targets.map((t) => (
            <Line key={t.categoryId ?? "buffer"} {...t} href={detailHref(t.categoryId)} />
          ))}
          <Line name={`Total for ${year}`} {...total} strong />
        </ul>
      )}
    </section>
  );
}
