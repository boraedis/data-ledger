import Link from "next/link";
import { categoryOptions } from "@/lib/categorize/labels";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { GROUP_LABELS, nextPeriod, type PayLineGroup } from "@/lib/pay/stubs";
import { listCategories } from "@/operations/categories";
import { listPayStubs } from "@/operations/pay";
import { read } from "@/operations/runtime";
import { PayStubs } from "./pay-stubs";

// Pay stubs (#60): what each paycheck really was, gross to net. This
// year's totals on top; the tax estimate (#61) builds on the same records.

const GROUPS: PayLineGroup[] = ["tax", "insurance", "retirement", "other"];

export default async function PayPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const [stubs, cats] = await Promise.all([read(db, listPayStubs, {}), read(db, listCategories, {})]);
  const options = categoryOptions(cats);
  const labelOf = new Map(options.map((o) => [o.id, o.label]));

  const thisYear = stubs.filter((s) => s.payDate.startsWith(String(year)));
  const sum = (pick: (s: (typeof stubs)[number]) => number) => thisYear.reduce((total, s) => total + pick(s), 0);
  // Paid by the employer on top (#92): money only, not imputed income.
  const employerOf = (kinds: string[]) => (s: (typeof stubs)[number]) => s.employerLines.filter((l) => kinds.includes(l.kind)).reduce((t, l) => t + l.amountCents, 0);
  const employerPaid = sum(employerOf(["retirement_match", "hsa", "life_insurance", "other"]));
  const match = sum(employerOf(["retirement_match"]));

  const last = stubs[0];
  const blank = {
    employer: "",
    periodStart: today,
    periodEnd: today,
    payDate: today,
    grossCents: 0,
    netCents: 0,
    lines: [
      { kind: "federal_income_tax", label: "Federal income tax", amountCents: 0, categoryId: null },
      { kind: "social_security", label: "Social Security", amountCents: 0, categoryId: null },
      { kind: "medicare", label: "Medicare", amountCents: 0, categoryId: null },
    ],
    employerLines: [],
    oneTime: false,
  };
  // The next regular paycheck, even when the last stub was a bonus.
  const next = last ? { ...last, ...nextPeriod(last), oneTime: false } : blank;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Pay</h1>
        <p className="text-sm text-muted-foreground">
          Each pay stub, gross to net. A stub linked to its deposit makes budgets count your gross pay and each deduction, instead of only what reached the
          bank. Amounts and labels only; never enter an SSN, employer ID or address.
        </p>
      </div>

      {thisYear.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">
            {year} so far <span className="text-sm font-normal text-muted-foreground">· {thisYear.length} pay stub{thisYear.length === 1 ? "" : "s"}</span>
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Gross pay</dt>
              <dd className="tabular-nums">{formatCents(sum((s) => s.grossCents))}</dd>
            </div>
            {GROUPS.map((g) =>
              sum((s) => s.totals[g]) ? (
                <div key={g} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{GROUP_LABELS[g]}</dt>
                  <dd className="tabular-nums">{formatCents(sum((s) => s.totals[g]))}</dd>
                </div>
              ) : null,
            )}
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Take-home</dt>
              <dd className="tabular-nums">{formatCents(sum((s) => s.netCents))}</dd>
            </div>
            {employerPaid ? (
              <>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">Paid by your employer</dt>
                  <dd className="tabular-nums">{formatCents(employerPaid)}</dd>
                  {match ? <dd className="text-xs text-muted-foreground">401(k) match {formatCents(match)}</dd> : null}
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">Total pay, with benefits</dt>
                  <dd className="tabular-nums">{formatCents(sum((s) => s.grossCents) + employerPaid)}</dd>
                </div>
              </>
            ) : null}
          </dl>
          <Link href="/pay/taxes" className="inline-block text-sm text-muted-foreground underline">
            Year-end tax estimate →
          </Link>
        </section>
      ) : null}

      <PayStubs
        stubs={stubs.map((s) => ({
          ...s,
          lines: s.lines.map((l) => ({ ...l, categoryLabel: l.categoryId ? (labelOf.get(l.categoryId) ?? null) : null })),
        }))}
        next={next}
        options={options}
      />
    </div>
  );
}
