import Link from "next/link";
import type { OddStub, PayPeriod } from "@/lib/cashflow/pay-periods";
import { formatCents } from "@/lib/money";

// The Pay periods tab (#175): how far each paycheck went. A bar per
// paycheck of what was left over (green) or overspent (red) against the
// paycheck, oldest to newest, then a row per period with its pay, cash out,
// left over, what the budget's targets planned for those days, and a link
// to its spending. Bonuses and stubs that need a gross figure are listed on
// their own, outside the periods. Server-rendered.

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatCents(Math.abs(cents))}`;

export function PayPeriods({ periods, oneTime, needsGross, year }: { periods: PayPeriod[]; oneTime: OddStub[]; needsGross: OddStub[]; year: string }) {
  if (!periods.length && !oneTime.length && !needsGross.length) {
    return (
      <p className="rounded-lg border p-3 text-sm text-muted-foreground">
        No pay stubs paid in {year}. Pay periods start from each paycheck&apos;s stub;{" "}
        <Link href="/pay" className="underline">
          add them on Pay
        </Link>
        .
      </p>
    );
  }
  const oldestFirst = [...periods].reverse();
  const scale = Math.max(1, ...periods.map((p) => Math.abs(p.leftOverCents)));
  const finished = periods.filter((p) => !p.inProgress);
  const average = finished.length ? Math.round(finished.reduce((s, p) => s + p.leftOverCents, 0) / finished.length) : null;

  return (
    <div className="space-y-4">
      {periods.length ? (
        <figure className="space-y-1">
          <figcaption className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
            <span>Left over from each paycheck, oldest first</span>
            {average !== null ? (
              <span className="tabular-nums">
                Average over {finished.length} finished {finished.length === 1 ? "period" : "periods"}:{" "}
                <span className={average < 0 ? "text-negative" : "text-foreground"}>{signed(average)}</span>
              </span>
            ) : null}
          </figcaption>
          {/* Above the line, left over; below, overspent. Each bar is its period's, with a label for screen readers. */}
          <ol className="flex h-28 items-stretch gap-1 border-b border-border">
            {oldestFirst.map((p) => {
              const h = `${(Math.abs(p.leftOverCents) / scale) * 50}%`;
              return (
                <li
                  key={p.start}
                  className="relative flex-1"
                  title={`${day(p.start)}: ${signed(p.leftOverCents)}${p.inProgress ? " so far" : ""}`}
                  aria-label={`Paid ${day(p.start)}: ${p.leftOverCents < 0 ? `${formatCents(-p.leftOverCents)} more out than paid` : `${formatCents(p.leftOverCents)} left over`}${p.inProgress ? " so far" : ""}`}
                >
                  <span
                    className={`absolute inset-x-0 mx-auto max-w-6 ${p.leftOverCents < 0 ? "top-1/2 rounded-b-[4px] bg-negative/70" : "bottom-1/2 rounded-t-[4px] bg-positive/70"} ${p.inProgress ? "opacity-60" : ""}`}
                    style={{ height: h }}
                  />
                </li>
              );
            })}
          </ol>
          <ol className="flex gap-1 text-[10px] text-muted-foreground" aria-hidden>
            {oldestFirst.map((p, i) => (
              // Past a dozen periods, every other date, so labels don't collide.
              <li key={p.start} className="flex-1 truncate text-center">
                {oldestFirst.length <= 12 || (oldestFirst.length - 1 - i) % 2 === 0 ? (p.inProgress ? `${day(p.start)}, so far` : day(p.start)) : ""}
              </li>
            ))}
          </ol>
        </figure>
      ) : null}

      {periods.length ? (
        <div>
          {/* Fits a phone without scrolling: the targets column waits for room, and each period's spending link sits under its dates. */}
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">Each pay period: paid, pay, cash out, left over and the budget&apos;s targets for those days</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="pb-1 font-normal">
                  Period
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Pay
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Cash out
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Left over
                </th>
                <th scope="col" className="hidden pb-1 text-right font-normal sm:table-cell">
                  Targets
                </th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.start} className="border-t align-top">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                    <span className="block">
                      {day(p.start)} – {day(p.end)}
                      {p.inProgress ? <span className="text-muted-foreground"> so far</span> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {p.employers.join(", ")}
                      {p.otherInCents ? ` · also ${formatCents(p.otherInCents)} in` : ""} ·{" "}
                      <Link href={`/spending?from=${p.start}&to=${p.end}`} className="underline hover:text-foreground">
                        Spending
                      </Link>
                    </span>
                  </th>
                  <td className="py-1.5 pr-2 text-right">{formatCents(p.payCents)}</td>
                  <td className="py-1.5 pr-2 text-right">{formatCents(p.outCents)}</td>
                  <td className={`py-1.5 text-right font-medium sm:pr-2 ${p.leftOverCents < 0 ? "text-negative" : ""}`}>{signed(p.leftOverCents)}</td>
                  <td className="hidden py-1.5 text-right text-muted-foreground sm:table-cell">{formatCents(p.targetsCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {oneTime.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-medium">One-time pay</h3>
          <p className="text-xs text-muted-foreground">Kept out of the periods&apos; pay and left over, so a bonus doesn&apos;t read as a good fortnight.</p>
          <ul className="divide-y rounded-lg border text-sm">
            {oneTime.map((s) => (
              <li key={`${s.payDate}-${s.employer}`} className="flex justify-between gap-3 px-3 py-1.5 tabular-nums">
                <span>
                  {day(s.payDate)} · {s.employer}
                </span>
                <span>{formatCents(s.netCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {needsGross.length ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {needsGross.length === 1 ? "A stub has" : `${needsGross.length} stubs have`} only a net figure (
          {needsGross.map((s) => `${day(s.payDate)}, ${formatCents(s.netCents)}`).join("; ")}), so {needsGross.length === 1 ? "it isn't" : "they aren't"} counted as a
          paycheck here.{" "}
          <Link href="/pay" className="underline">
            Add the gross and deductions on Pay
          </Link>
        </p>
      ) : null}
    </div>
  );
}
