import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { GROUP_LABELS } from "@/lib/pay/stubs";
import { read } from "@/operations/runtime";
import { taxEstimate } from "@/operations/taxes";
import { AssumptionsForm } from "./assumptions-form";

// The year's tax position from pay stubs (#61): withholding so far, where
// it's heading at the current pace, and roughly what that leaves owed or
// refunded. Computed on read from the owner's own numbers; an estimate,
// never advice.

function Row({ label, ytd, projected, strong }: { label: string; ytd: number | null; projected: number; strong?: boolean }) {
  return (
    <tr className={`border-t ${strong ? "font-medium" : ""}`}>
      <td className="py-1.5 pr-2">{label}</td>
      <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{ytd === null ? "" : formatCents(ytd)}</td>
      <td className="py-1.5 text-right tabular-nums">{formatCents(projected)}</td>
    </tr>
  );
}

function Line({ label, cents, sign = "" }: { label: string; cents: number; sign?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {sign}
        {formatCents(cents)}
      </dd>
    </div>
  );
}

export default async function TaxesPage(props: PageProps<"/pay/taxes">) {
  const sp = await props.searchParams;
  const thisYear = new Date().getUTCFullYear();
  const asked = Number(Array.isArray(sp.year) ? sp.year[0] : sp.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : thisYear;
  const { estimate, assumptions, hasTables } = await read(getDb(), taxEstimate, { year });
  const federal = estimate?.federal;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Taxes {year}</h1>
        <nav className="flex gap-3 text-sm">
          <Link href={`/pay/taxes?year=${year - 1}`} className="text-muted-foreground underline">
            ← {year - 1}
          </Link>
          {year < thisYear ? (
            <Link href={`/pay/taxes?year=${year + 1}`} className="text-muted-foreground underline">
              {year + 1} →
            </Link>
          ) : null}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        An estimate from your pay stubs and the assumptions below, not tax advice. Federal income tax only: state income tax shows what&apos;s withheld,
        but what you&apos;ll owe depends on rules this doesn&apos;t model. Nothing here is sent to Tally or the model.
      </p>

      {!estimate ? (
        <p className="text-muted-foreground">
          No pay stubs for {year} yet. Add them on <Link className="underline" href="/pay">Pay</Link>; the estimate builds from there.
        </p>
      ) : (
        <>
          {estimate.missingEarlierPay ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              Your first {year} pay stub starts {estimate.firstPeriodStart}, so pay before then isn&apos;t counted and this year&apos;s figures are too
              low. Add the earlier stubs on <Link className="underline" href="/pay">Pay</Link> (or that pay&apos;s gross as other income below) for a
              real estimate.
            </p>
          ) : null}
          {federal ? (
            <section className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">At this pace, at filing you&apos;d likely</p>
              <p className="text-3xl font-semibold tabular-nums">
                {federal.balanceCents >= 0 ? "get back " : "owe "}
                {formatCents(Math.abs(federal.balanceCents))}
              </p>
              <p className="text-sm text-muted-foreground">
                in federal income tax · {estimate.stubCount} pay stub{estimate.stubCount === 1 ? "" : "s"} so far, {estimate.remainingPaychecks} more paycheck
                {estimate.remainingPaychecks === 1 ? "" : "s"} expected (every {estimate.cadenceDays} days)
              </p>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">
              {hasTables ? "" : `There are no federal tax tables for ${year} here yet, so this shows withholding and its pace without an estimate of what's owed.`}
            </p>
          )}

          <section className="space-y-2">
            <h2 className="text-lg font-medium">Withheld</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="pb-1 text-left font-normal">From {estimate.stubCount} pay stubs</th>
                  <th className="pb-1 text-right font-normal">So far</th>
                  <th className="pb-1 text-right font-normal">Year at this pace</th>
                </tr>
              </thead>
              <tbody>
                <Row label="Gross pay" ytd={estimate.gross.ytdCents} projected={estimate.gross.projectedCents} strong />
                {estimate.taxes.map((t) => (
                  <Row key={t.kind} label={t.label} ytd={t.ytdCents} projected={t.projectedCents} />
                ))}
                {estimate.groups.length ? (
                  <tr>
                    <td colSpan={3} className="pb-1 pt-4 text-xs text-muted-foreground">
                      Not taxes, also taken from pay:
                    </td>
                  </tr>
                ) : null}
                {estimate.groups.map((g) => (
                  <Row key={g.group} label={GROUP_LABELS[g.group]} ytd={g.ytdCents} projected={g.projectedCents} />
                ))}
              </tbody>
            </table>
          </section>

          {federal ? (
            <section className="space-y-2">
              <h2 className="text-lg font-medium">How the federal estimate adds up</h2>
              <dl className="space-y-1 rounded-lg border p-3 text-sm">
                <Line
                  label={
                    estimate.employer.imputed.projectedCents
                      ? "Wages after pre-tax deductions (401(k), HSA, FSA, insurance), with imputed life-insurance income"
                      : "Wages after pre-tax deductions (401(k), HSA, FSA, insurance)"
                  }
                  cents={federal.wagesCents}
                />
                {assumptions.otherIncomeCents ? <Line label="Other income" cents={assumptions.otherIncomeCents} sign="+ " /> : null}
                <Line label={federal.itemized ? "Itemized deductions" : "Standard deduction"} cents={federal.deductionCents} sign="− " />
                <Line label="Taxable income" cents={federal.taxableIncomeCents} sign="= " />
                <Line label="Federal income tax, after credits" cents={federal.liabilityCents} />
                <Line label="Paid: withholding at this pace, plus other payments" cents={federal.paidCents} />
              </dl>
            </section>
          ) : null}

          {estimate.hsa ? (
            <section className="space-y-1 text-sm">
              <h2 className="text-lg font-medium">HSA</h2>
              <p className="text-muted-foreground">
                Your contributions through payroll and your employer&apos;s share one yearly limit. Contributions made outside payroll aren&apos;t
                counted here.
              </p>
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="pb-1 text-left font-normal" />
                    <th className="pb-1 text-right font-normal">So far</th>
                    <th className="pb-1 text-right font-normal">Year at this pace</th>
                  </tr>
                </thead>
                <tbody>
                  <Row label="Yours" ytd={estimate.hsa.yours.ytdCents} projected={estimate.hsa.yours.projectedCents} />
                  <Row label="Your employer's" ytd={estimate.hsa.employer.ytdCents} projected={estimate.hsa.employer.projectedCents} />
                  <Row label="Together" ytd={estimate.hsa.yours.ytdCents + estimate.hsa.employer.ytdCents} projected={estimate.hsa.projectedCents} strong />
                </tbody>
              </table>
              {estimate.hsa.limitCents === null ? (
                <p className="text-muted-foreground">
                  {assumptions.hsaCoverage
                    ? `There's no HSA limit for ${year} here yet.`
                    : "Set your HSA coverage in the assumptions below to check this against the year's limit."}
                </p>
              ) : estimate.hsa.projectedCents > estimate.hsa.limitCents ? (
                <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
                  At this pace, {formatCents(estimate.hsa.projectedCents - estimate.hsa.limitCents)} over the {year} limit of{" "}
                  {formatCents(estimate.hsa.limitCents)}. Lower your payroll contribution before the year ends; an excess is taxed unless it&apos;s
                  withdrawn.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {formatCents(estimate.hsa.limitCents - estimate.hsa.projectedCents)} of room left under the {year} limit of{" "}
                  {formatCents(estimate.hsa.limitCents)}, at this pace.
                </p>
              )}
            </section>
          ) : null}

          {estimate.employer.lines.length || estimate.employer.imputed.ytdCents ? (
            <section className="space-y-2 text-sm">
              <h2 className="text-lg font-medium">Paid by your employer</h2>
              <table className="w-full">
                <tbody>
                  {estimate.employer.lines.map((l) => (
                    <Row key={l.kind} label={l.label} ytd={l.ytdCents} projected={l.projectedCents} />
                  ))}
                  {estimate.employer.lines.length > 1 ? (
                    <Row label="Total, on top of gross pay" ytd={estimate.employer.total.ytdCents} projected={estimate.employer.total.projectedCents} strong />
                  ) : null}
                  {estimate.employer.imputed.ytdCents ? (
                    <Row label="Imputed income (taxable, not paid; in the estimate)" ytd={estimate.employer.imputed.ytdCents} projected={estimate.employer.imputed.projectedCents} />
                  ) : null}
                </tbody>
              </table>
            </section>
          ) : null}

          {estimate.fica ? (
            <section className="space-y-1 text-sm">
              <h2 className="text-lg font-medium">Social Security and Medicare</h2>
              <p className="text-muted-foreground">A check on the payroll math: what these should come to on your wages, against what&apos;s being withheld.</p>
              <dl className="space-y-1 rounded-lg border p-3">
                <Line label={`Social Security, expected (6.2% up to the wage base)`} cents={estimate.fica.socialSecurity.expectedCents} />
                <Line label="Social Security, withheld at this pace" cents={estimate.fica.socialSecurity.projectedCents} />
                <Line label="Medicare, expected (1.45%)" cents={estimate.fica.medicare.expectedCents} />
                <Line label="Medicare, withheld at this pace" cents={estimate.fica.medicare.projectedCents} />
              </dl>
              {estimate.fica.socialSecurity.projectedCents > estimate.fica.socialSecurity.expectedCents + 100 ? (
                <p className="text-warning">
                  More Social Security is being withheld than the wage base allows. With two jobs, the excess comes back when you file.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Your assumptions for {year}</h2>
        <AssumptionsForm key={year} initial={{ year, ...assumptions }} />
      </section>
    </div>
  );
}
