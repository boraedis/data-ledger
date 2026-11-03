import Link from "next/link";
import type { Summary } from "../pay-strip";
import type { ToplinePay } from "../topline";

// Pay across the Year view's months (#138), in its topline (#268): the same
// figures as the month's, for the twelve months shown, each as a % of their
// net pay. Actual pay here, not a typical month (#142): the year is the sum
// of the months under the grid, which a typical month wouldn't add up to.

export function yearPay({
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
}): ToplinePay {
  return {
    summary,
    netPayLabel: "Net pay",
    netPayNote: monthsWithoutPay ? `${12 - monthsWithoutPay} of 12 months` : "all 12 months",
    note: (
      <>
        Pay as it landed, month by month: pay stubs by pay date{isCurrent ? ", with this month's paychecks still to come" : ""}. Targets count at
        their monthly share.
        {monthsWithoutPay
          ? ` ${monthsWithoutPay} month${monthsWithoutPay === 1 ? "" : "s"} with no pay recorded ${monthsWithoutPay === 1 ? "is" : "are"} left out of the pay figures, targets and spending too, so they compare like with like.`
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
      </>
    ),
    none: (
      <>
        No pay recorded in these months. <Link href="/pay" className="underline">Add pay stubs</Link> to see what the budget leaves to save.
      </>
    ),
  };
}
