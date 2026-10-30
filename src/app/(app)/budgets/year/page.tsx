import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { budgetMonthly } from "@/operations/budgets";
import { read } from "@/operations/runtime";

// Every target's spend against target, month by month (#108): one row per
// target (the buffer first), one column per month for the last 12, so a
// pattern across categories shows at a glance. ?month=YYYY-MM is the last
// column; ?gross=1 as on Budgets.
//
// Each cell is what budgets.status counted toward that target that month,
// against the version in effect then, so a past month keeps the target it
// had. Targets that have since ended keep their row. The whole grid comes
// from one budgets.monthly read: one query for the window's lines, not one
// per cell.
//
// A real table, so screen readers get rows and columns. It's sized to fit a
// phone: on a narrow screen cells are color only (each still has a label,
// and each row says how many months went over), and amounts appear where
// there's room for them.

const MONTHS = 12;

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

const monthName = (month: string, style: "narrow" | "short" | "long") =>
  new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: style,
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

/** "+$42", "−$1.2k": the cell's over (+) or under (−), short enough for a column. */
function compactDiff(cents: number): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1_000) return `${sign}$${(dollars / 1_000).toFixed(dollars >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}$${Math.round(dollars)}`;
}

// Diverging around the target: under in the on-track color, over in the
// over-budget color, three steps each by how far off. Capped well short of
// solid so the amount on top stays legible in both themes.
function shade(spent: number, target: number): string {
  const ratio = target > 0 ? spent / target : spent > 0 ? Infinity : 0;
  if (ratio > 1) return ratio > 1.25 ? "bg-negative/60" : ratio > 1.1 ? "bg-negative/40" : "bg-negative/20";
  return ratio < 0.5 ? "bg-positive/45" : ratio < 0.9 ? "bg-positive/30" : "bg-positive/15";
}

export default async function BudgetYearPage(props: PageProps<"/budgets/year">) {
  const sp = await props.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const requested = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const month = requested > thisMonth ? thisMonth : requested;
  const isCurrent = month === thisMonth;
  const on = isCurrent ? today : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const gross = sp.gross === "1";

  const rows = (await read(getDb(), budgetMonthly, { on, gross, months: MONTHS, includeEnded: true })).sort((a, b) =>
    a.categoryId === null ? -1 : b.categoryId === null ? 1 : a.name.localeCompare(b.name),
  );
  const columns = rows[0]?.months.map((m) => m.month) ?? Array.from({ length: MONTHS }, (_, i) => `${shiftMonth(month, i - MONTHS + 1)}-01`);
  const partial = isCurrent ? `${month}-01` : null;

  const href = (path: "/budgets" | "/budgets/year", next: { month?: string; gross?: boolean }) => {
    const q = new URLSearchParams();
    const m = next.month ?? month;
    if (m !== thisMonth) q.set("month", m);
    if (next.gross ?? gross) q.set("gross", "1");
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  const later = shiftMonth(month, MONTHS) > thisMonth ? thisMonth : shiftMonth(month, MONTHS);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Budgets by month</h1>
        <nav className="flex items-center gap-3 text-sm">
          <Link href={href("/budgets/year", { month: shiftMonth(month, -MONTHS) })} className="text-muted-foreground hover:text-foreground">
            ← Earlier
          </Link>
          <span className="font-medium">
            {monthName(columns[0], "long")} – {monthName(columns.at(-1)!, "long")}
          </span>
          {isCurrent ? null : (
            <Link href={href("/budgets/year", { month: later })} className="text-muted-foreground hover:text-foreground">
              Later →
            </Link>
          )}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        Each target&apos;s spending against the target it had that month: green under, red over, deeper the further off, with the amount over (+) or under (−) where there&apos;s room.
        A multi-month target is measured against its even monthly share. Tap a month to open it.{" "}
        {gross ? (
          <>
            Showing gross spending.{" "}
            <Link href={href("/budgets/year", { gross: false })} className="underline">
              Show your share
            </Link>
          </>
        ) : (
          <>
            Shared expenses count only your share.{" "}
            <Link href={href("/budgets/year", { gross: true })} className="underline">
              Show gross
            </Link>
          </>
        )}{" "}
        · <Link href={href("/budgets", {})} className="underline">Back to {monthName(month, "long")}</Link>
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No targets in effect in these months.</p>
      ) : (
        <table className="w-full table-fixed border-separate border-spacing-0.5 text-xs">
          <caption className="sr-only">
            Spending against target by month, {monthName(columns[0], "long")} to {monthName(columns.at(-1)!, "long")}
            {partial ? " (the last month so far)" : ""}
          </caption>
          <colgroup>
            <col className="w-24 sm:w-40" />
            {columns.map((c) => (
              <col key={c} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Target
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  scope="col"
                  abbr={monthName(c, "long")}
                  className={`pb-1 text-center font-normal text-muted-foreground ${c.slice(0, 7) === month ? "font-medium text-foreground" : ""}`}
                >
                  <span className="md:hidden">{monthName(c, "narrow")}</span>
                  <span className="hidden md:inline">{monthName(c, "short")}</span>
                  {/* Where the year turns, so twelve months never read as one calendar year. */}
                  {c.slice(5, 7) === "01" ? <span className="block text-[9px] leading-none">{c.slice(2, 4)}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const targeted = r.months.filter((m) => m.targetCents !== null);
              const over = targeted.filter((m) => m.spentCents > m.targetCents!).length;
              return (
                <tr key={r.categoryId ?? "buffer"}>
                  <th scope="row" className="pr-1 text-left align-middle font-normal">
                    <span className="block truncate text-sm" title={r.name}>
                      {r.categoryId === null ? "Buffer" : r.name}
                    </span>
                    <span className="block text-[10px] text-muted-foreground tabular-nums">
                      over {over} of {targeted.length}
                    </span>
                  </th>
                  {r.months.map((m) => {
                    const label =
                      m.targetCents === null
                        ? `${r.name}, ${monthName(m.month, "long")}: no target`
                        : `${r.name}, ${monthName(m.month, "long")}${m.month === partial ? " so far" : ""}: ${formatCents(m.spentCents)} of ${formatCents(m.targetCents)}, ` +
                          (m.spentCents > m.targetCents
                            ? `${formatCents(m.spentCents - m.targetCents)} over`
                            : `${formatCents(m.targetCents - m.spentCents)} under`);
                    return (
                      <td key={m.month} className="h-9 p-0">
                        <Link
                          href={href("/budgets", { month: m.month.slice(0, 7) })}
                          aria-label={label}
                          title={label}
                          className={`flex h-full items-center justify-center rounded-sm tabular-nums hover:ring-1 hover:ring-foreground/50 focus-visible:outline-2 focus-visible:outline-ring ${
                            m.targetCents === null ? "bg-muted/50 text-muted-foreground" : shade(m.spentCents, m.targetCents)
                          } ${m.month === partial ? "outline-1 -outline-offset-2 outline-dashed outline-foreground/40" : ""}`}
                        >
                          <span aria-hidden className="hidden text-[10px] md:inline">
                            {m.targetCents === null ? "–" : compactDiff(m.spentCents - m.targetCents)}
                          </span>
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          Under
          <span className="size-3 rounded-sm bg-positive/45" aria-hidden />
          <span className="size-3 rounded-sm bg-positive/30" aria-hidden />
          <span className="size-3 rounded-sm bg-positive/15" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/20" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/40" aria-hidden />
          <span className="size-3 rounded-sm bg-negative/60" aria-hidden />
          Over
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-muted/50" aria-hidden />
          No target that month
        </span>
        {partial ? (
          <span className="flex items-center gap-1">
            <span className="size-3 rounded-sm outline-1 -outline-offset-2 outline-dashed outline-foreground/40" aria-hidden />
            So far this month
          </span>
        ) : null}
      </div>
    </div>
  );
}
