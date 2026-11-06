import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { merchantDetail } from "@/operations/merchant-views";
import { listMerchants, listMerchantTypes } from "@/operations/merchants";
import { read } from "@/operations/runtime";
import { NotFoundError } from "@/operations/tracked";
import { MerchantControls, SplitButton } from "./controls";
import { privacyMode } from "@/lib/privacy/server";

// One merchant (#286): what it's cost by month, its names (the cleaned
// spellings that belong to it) and the raw bank descriptions behind them,
// its latest transactions, and the changes: rename, type, merge, split.
// Net spend by default, as on Spending.

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const day = (on: string) => new Date(`${on}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthLabel = (m: string, style: "short" | "long" = "short") =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: style, ...(style === "long" ? { year: "numeric" } : {}), timeZone: "UTC" });

export default async function MerchantPage(props: PageProps<"/merchants/[id]">) {
  await privacyMode();
  const { id } = await props.params;
  const gross = one((await props.searchParams).gross) === "1";
  const db = getDb();
  const detail = await read(db, merchantDetail, { merchantId: id, gross }).catch((e) => {
    if (e instanceof NotFoundError || (e instanceof Error && /invalid|uuid/i.test(e.message))) return null;
    throw e;
  });
  if (!detail) notFound();
  const [types, all] = await Promise.all([read(db, listMerchantTypes, {}), read(db, listMerchants, {})]);
  const top = Math.max(1, ...detail.months.map((m) => m.spentCents));
  const yearCents = detail.months.reduce((s, m) => s + m.spentCents, 0);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={gross ? "/merchants?gross=1" : "/merchants"} className="text-sm text-muted-foreground hover:text-foreground">
          ← Merchants
        </Link>
        <h1 className="text-2xl font-semibold">{detail.name}</h1>
        <p className="text-sm text-muted-foreground">
          {detail.type ?? "No type"} · {formatCents(detail.spentCents)} spent in all, {gross ? "gross" : "net of what friends owe"} ·{" "}
          <Link href={gross ? `/merchants/${id}` : `/merchants/${id}?gross=1`} className="underline">
            {gross ? "Show your share" : "Show gross"}
          </Link>
        </p>
      </div>

      <section aria-label="The last 12 months" className="space-y-2">
        <h2 className="text-lg font-medium">
          The last 12 months <span className="text-sm font-normal text-muted-foreground tabular-nums">· {formatCents(yearCents)}</span>
        </h2>
        {/* Plain HTML bars: each month's words are its own text alternative. */}
        <ol className="grid grid-cols-12 items-end gap-1" style={{ height: "6rem" }}>
          {detail.months.map((m) => (
            <li key={m.month} className="flex h-full flex-col justify-end" title={`${monthLabel(m.month, "long")}: ${formatCents(m.spentCents)}`}>
              <span className="sr-only">
                {monthLabel(m.month, "long")}: {formatCents(m.spentCents)}
              </span>
              <span aria-hidden className="block rounded-sm bg-primary" style={{ height: `${(Math.max(0, m.spentCents) / top) * 100}%`, minHeight: m.spentCents > 0 ? 2 : 0 }} />
            </li>
          ))}
        </ol>
        <div aria-hidden className="grid grid-cols-12 gap-1 text-center text-[10px] text-muted-foreground">
          {detail.months.map((m) => (
            <span key={m.month}>{monthLabel(m.month).slice(0, 1)}</span>
          ))}
        </div>
      </section>

      <MerchantControls
        merchant={{ id: detail.id, name: detail.name, typeId: detail.typeId }}
        types={types}
        others={all.filter((m) => m.id !== detail.id).map((m) => ({ id: m.id, name: m.name }))}
      />

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Names</h2>
          <p className="text-xs text-muted-foreground">The cleaned spellings that count as this merchant. A new transaction under any of them comes here.</p>
          <ul className="divide-y rounded-lg border text-sm">
            {detail.aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">{a.alias}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">{a.transactions}</span>
                  {detail.aliases.length > 1 ? <SplitButton aliasId={a.id} alias={a.alias} /> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-2">
          <h2 className="text-lg font-medium">As the bank wrote it</h2>
          <p className="text-xs text-muted-foreground">The raw descriptions behind those names, most seen first. They&apos;re never changed.</p>
          {detail.descriptors.length ? (
            <ul className="divide-y rounded-lg border font-mono text-xs">
              {detail.descriptors.map((d) => (
                <li key={d.description} className="flex justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 break-all">{d.description}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{d.n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No transactions yet.</p>
          )}
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Transactions</h2>
        {detail.recent.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {detail.recent.map((t) => (
              <li key={t.id}>
                <Link href={`/transactions/${t.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="block truncate">{t.description}</span>
                    <span className="block text-xs text-muted-foreground">
                      {day(t.postedOn)} · {t.accountName} · {t.category ?? "Uncategorized"}
                    </span>
                  </span>
                  <span className={`shrink-0 tabular-nums ${t.amountCents > 0 ? "text-positive" : ""}`}>{formatCents(t.amountCents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        )}
        {detail.recent.length === 100 ? <p className="text-xs text-muted-foreground">The latest 100.</p> : null}
      </section>
    </div>
  );
}
