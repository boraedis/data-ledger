import Link from "next/link";
import { Tile, type Summary } from "../pay-strip";

// Pay across the Year view's months (#138): the same five figures as the
// month's strip, for the twelve months shown, each as a % of their net pay.
// Actual pay here, not a typical month (#142): the year is the sum of the
// months under the grid, which a typical month wouldn't add up to.

export function PayYear({
  summary,
  monthsWithoutPay,
  isCurrent,
  oneTimeCount,
  oneTimeLeftOut,
  toggleOneTimeHref,
}: {
  summary: Summary | null;
  monthsWithoutPay: number;
  isCurrent: boolean;
  oneTimeCount: number;
  oneTimeLeftOut: boolean;
  toggleOneTimeHref: string;
}) {
  if (!summary) {
    return (
      <section aria-label="Pay across these months" className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
        No pay recorded in these months. <Link href="/pay" className="underline">Add pay stubs</Link> to see what the budget leaves to save.
      </section>
    );
  }
  const soFar = isCurrent ? " so far" : "";
  return (
    <section aria-label="Pay across these months" className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Net pay" figure={{ ...summary.netPay, percent: null }} note={monthsWithoutPay ? `${12 - monthsWithoutPay} of 12 months` : "all 12 months"} />
        <Tile label="Total targets" figure={summary.targets} />
        <Tile label="Expected saving" figure={summary.expectedSaving} signed />
        <Tile label={`Spent${soFar}`} figure={summary.spent} />
        <Tile label={`Saved${soFar}`} figure={summary.actualSaving} signed />
      </div>
      <p className="text-xs text-muted-foreground">
        Pay as it landed, month by month: pay stubs by pay date{isCurrent ? ", with this month's paychecks still to come" : ""}. Targets count at
        their monthly share.
        {monthsWithoutPay
          ? ` ${monthsWithoutPay} month${monthsWithoutPay === 1 ? "" : "s"} with no pay recorded ${monthsWithoutPay === 1 ? "is" : "are"} left out, targets and spending too, so the figures compare like with like.`
          : ""}
        {oneTimeCount ? (
          <>
            {" "}
            {oneTimeLeftOut
              ? `${oneTimeCount} one-time payment${oneTimeCount === 1 ? "" : "s"} (a bonus) left out. `
              : `Includes ${oneTimeCount} one-time payment${oneTimeCount === 1 ? "" : "s"} (a bonus). `}
            <Link href={toggleOneTimeHref} className="underline">
              {oneTimeLeftOut ? "Include it" : "Leave it out"}
            </Link>
          </>
        ) : null}
      </p>
    </section>
  );
}
