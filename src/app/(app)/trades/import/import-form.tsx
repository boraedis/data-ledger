"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DATE_FORMATS, type DateFormat } from "@/lib/history/csv";
import { formatCents } from "@/lib/money";
import { ACTION_CATEGORIES, ACTION_LABELS, bySign, type ActionCategory, type BrokerageMapping } from "@/lib/trades/import-csv";
import { draftHeadline } from "../fields";
import { applyTradeImport, previewTradeImport, type Applied, type Preview, type PreviewRow } from "./actions";

// The brokerage import's steps on one screen (#357), as the bank import's:
// pick the account and file; check the columns and what each action means
// (guessed, or as saved for this account); see what each row would add and
// what's already here; then apply. Nothing is written before Apply.

const select = "h-9 rounded-md border bg-background px-2 text-sm";
const MAX_ERRORS = 20;

type Columns = "date" | "settleDate" | "action" | "symbol" | "quantity" | "price" | "amount" | "description";
const COLUMNS: { key: Columns; label: string; optional?: boolean }[] = [
  { key: "date", label: "Trade date" },
  { key: "settleDate", label: "Settlement date", optional: true },
  { key: "action", label: "Action" },
  { key: "symbol", label: "Symbol" },
  { key: "quantity", label: "Quantity" },
  { key: "price", label: "Price", optional: true },
  { key: "amount", label: "Amount (cash)" },
  { key: "description", label: "Description", optional: true },
];

/** What a row would do, in words, and whether ticking it adds anything. */
function rowWords(r: PreviewRow): { lines: string[]; adds: boolean } {
  const lines: string[] = [];
  if (r.trade && r.tradePlan) {
    const what = draftHeadline({ ...r.trade, onFrom: null });
    const priced = r.trade.price ? ` at $${r.trade.price}` : "";
    lines.push(
      r.tradePlan.status === "new"
        ? `Trade: ${what}${priced}`
        : r.tradePlan.status === "fills_draft"
          ? `Fills the waiting draft: ${what}${priced}`
          : r.tradePlan.status === "already"
            ? `Already ${r.tradePlan.dismissed ? "dismissed" : "recorded"}: ${what}`
            : `A sweep into the account's cash fund, not a trade: ${what}`,
    );
  }
  if (r.cash && r.cashPlan) {
    lines.push(
      r.cashPlan.status === "new"
        ? `Cash row: ${formatCents(r.cash.amountCents)} on ${r.cash.postedOn}`
        : `Cash already here from the sync: ${formatCents(r.cash.amountCents)}${r.linkTo ? ", linked to the trade" : ""}`,
    );
  }
  const adds = r.cashPlan?.status === "new" || r.tradePlan?.status === "new" || r.tradePlan?.status === "fills_draft";
  return { lines, adds };
}

export function TradeImportForm({ accounts, initialAccountId }: { accounts: { id: string; name: string }[]; initialAccountId: string }) {
  const [accountId, setAccountId] = useState(initialAccountId);
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Applied | null>(null);
  const [pending, startTransition] = useTransition();

  const load = (account: string, content: string, mapping: BrokerageMapping | null, ticked: string[] | null = null) =>
    startTransition(async () => {
      setError(null);
      setDone(null);
      const result = await previewTradeImport(account, content, mapping, ticked);
      if ("error" in result) {
        setPreview(null);
        setError(result.error);
      } else setPreview(result);
    });

  // A new mapping is a new reading of the file: ticks go back to the defaults.
  const remap = (patch: Partial<BrokerageMapping>) => preview && text && load(accountId, text, { ...preview.mapping, ...patch });
  const mapAction = (key: string, category: ActionCategory | "") => {
    if (!preview) return;
    const actions = { ...preview.mapping.actions };
    if (category) actions[key] = category;
    else delete actions[key];
    remap({ actions });
  };
  const ticked = preview ? preview.rows.filter((r) => r.ticked).map((r) => r.id) : [];
  // Ticks change what the baseline does, so the preview is asked again.
  const tick = (id: string, on: boolean) => preview && text && load(accountId, text, preview.mapping, on ? [...ticked, id] : ticked.filter((x) => x !== id));

  const header = preview ? (preview.sample[preview.mapping.skipRows] ?? []) : [];
  const columns = header.map((h, i) => ({ i, label: preview?.mapping.hasHeader && h.trim() ? `${i + 1}: ${h}` : `Column ${i + 1}` }));

  const apply = () =>
    startTransition(async () => {
      if (!preview || !text) return;
      const result = await applyTradeImport(accountId, text, preview.mapping, ticked);
      if ("error" in result) setError(result.error);
      else {
        setDone(result);
        setPreview(null);
        setText(null);
        setFileName("");
      }
    });

  const conflicts = preview?.baseline?.conflicts ?? [];

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Account
          <select
            className={select}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              // The saved mapping and what's already here are per account: read the file again.
              if (text) load(e.target.value, text, null);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          CSV export
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm text-foreground file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 4_000_000) {
                setError("That file is too big for one import. Export a year at a time.");
                return;
              }
              const content = await file.text();
              setText(content);
              setFileName(file.name);
              load(accountId, content, null);
            }}
          />
        </label>
        {pending ? <span className="pb-2 text-muted-foreground">Reading…</span> : null}
      </div>

      {error ? <p className="text-destructive">{error}</p> : null}
      {done ? (
        <p className="rounded-lg border px-3 py-2">
          Imported {done.trades} trade{done.trades === 1 ? "" : "s"} and {done.cashRows} cash row{done.cashRows === 1 ? "" : "s"}
          {done.draftsFilled ? `, and filled ${done.draftsFilled} draft${done.draftsFilled === 1 ? "" : "s"}` : ""}
          {done.baselineMovedTo ? `. The account's trade history now starts on ${done.baselineMovedTo}` : ""}. One entry in Activity undoes it all.{" "}
          <Link href={`/trades?account=${accountId}`} className="underline">
            See the trades
          </Link>{" "}
          ·{" "}
          <Link href={`/transactions?account=${accountId}`} className="underline">
            the cash rows
          </Link>
        </p>
      ) : null}

      {preview ? (
        <>
          <section className="space-y-2 rounded-lg border p-3">
            <h2 className="font-medium">Columns{fileName ? ` in ${fileName}` : ""}</h2>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i} className={i < preview.mapping.skipRows ? "text-muted-foreground line-through" : i === preview.mapping.skipRows && preview.mapping.hasHeader ? "font-medium" : ""}>
                      <td className="pr-2 text-muted-foreground">{i + 1}</td>
                      {r.map((c, j) => (
                        <td key={j} className="max-w-48 truncate border-l px-2 py-0.5">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Skip lines before the header
                <input
                  type="number"
                  min={0}
                  max={50}
                  className={`${select} w-20`}
                  value={preview.mapping.skipRows}
                  onChange={(e) => remap({ skipRows: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-xs">
                <input type="checkbox" checked={preview.mapping.hasHeader} onChange={(e) => remap({ hasHeader: e.target.checked })} />
                First line is a header
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Date format
                <select className={select} value={preview.mapping.dateFormat} onChange={(e) => remap({ dateFormat: e.target.value as DateFormat })}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              {COLUMNS.map((c) => {
                const value = preview.mapping[c.key];
                return (
                  <label key={c.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {c.label}
                    <select
                      className={select}
                      value={value === null ? "" : String(value)}
                      onChange={(e) => remap({ [c.key]: e.target.value === "" ? null : Number(e.target.value) } as Partial<BrokerageMapping>)}
                    >
                      {c.optional ? <option value="">None</option> : null}
                      {columns.map((col) => (
                        <option key={col.i} value={col.i}>
                          {col.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="space-y-2 rounded-lg border p-3">
            <h2 className="font-medium">What each action means</h2>
            <p className="text-xs text-muted-foreground">
              Guessed from the words, for you to check. Saved with this account&apos;s layout for next time. A row whose action isn&apos;t mapped
              isn&apos;t imported.
            </p>
            <ul className="divide-y">
              {preview.actions.map((a) => (
                <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 break-words">
                    {a.key} <span className="text-xs text-muted-foreground">· {a.rows} row{a.rows === 1 ? "" : "s"}</span>
                    {/* Why a by-sign meaning is offered, and what it does: the
                        file's own quantities, so the owner can check the guess. */}
                    {a.signs.positive + a.signs.negative > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        Quantities: {a.signs.positive} positive, {a.signs.negative} negative
                        {bySign(a.category)
                          ? a.category === "trade_by_sign"
                            ? ". Positive is a buy, negative a sell."
                            : ". Positive is shares in, negative shares out."
                          : ""}
                      </span>
                    ) : null}
                  </span>
                  <select
                    aria-label={`What "${a.key}" means`}
                    className={`${select} ${a.category ? "" : "border-warning text-warning"}`}
                    value={a.category ?? ""}
                    onChange={(e) => mapAction(a.key, e.target.value as ActionCategory | "")}
                  >
                    <option value="">Not mapped</option>
                    {ACTION_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {ACTION_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2 rounded-lg border p-3">
            <h2 className="font-medium">What this adds</h2>
            <p>
              {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} read; <strong>{ticked.length}</strong> ticked to import.
              {preview.reimported ? ` ${preview.reimported} imported before; skipped.` : ""} Unticked ones look like they&apos;re already here, or say what to check.
            </p>
            {preview.baseline && !conflicts.length ? (
              <p className="rounded-md border border-dashed p-2">
                The file reaches before {preview.baseline.from}, where this account&apos;s trade history starts. Importing moves the start to{" "}
                {preview.baseline.to}, and the opening shares it explains are taken off:{" "}
                {preview.baseline.openings.length
                  ? preview.baseline.openings.map((o) => `${o.symbol} opens with ${o.quantity}`).join(", ")
                  : "nothing is left to open with for the symbols it trades"}
                . What you held from {preview.baseline.from} on stays the same.
              </p>
            ) : null}
            {conflicts.length ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
                The file has more shares than this account held on {preview.baseline!.from}, when its trade history starts:{" "}
                {conflicts.map((c) => `${c.short} more ${c.symbol}`).join(", ")}. Untick those rows, or check the file is this account&apos;s.
              </p>
            ) : null}
            <ul className="divide-y text-xs">
              {preview.rows.map((r) => {
                const { lines, adds } = rowWords(r);
                return (
                  <li key={r.id} className="flex items-start gap-2 py-1.5">
                    <input type="checkbox" aria-label={`Import row ${r.row}`} disabled={!adds || pending} checked={r.ticked} onChange={(e) => tick(r.id, e.target.checked)} />
                    <span className={`min-w-0 flex-1 ${adds ? "" : "text-muted-foreground"}`}>
                      <span className="block truncate">
                        Row {r.row} · {r.action}
                      </span>
                      {lines.map((l) => (
                        <span key={l} className="block">
                          {l}
                        </span>
                      ))}
                      {r.warning ? <span className="block text-warning">{r.warning}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {preview.errors.length ? (
              <details className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
                <summary className="cursor-pointer">
                  {preview.errors.length} row{preview.errors.length === 1 ? "" : "s"} couldn&apos;t be read and won&apos;t be imported
                </summary>
                <ul className="mt-1 text-xs">
                  {preview.errors.slice(0, MAX_ERRORS).map((e) => (
                    <li key={e.row}>
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                  {preview.errors.length > MAX_ERRORS ? <li>…and {preview.errors.length - MAX_ERRORS} more</li> : null}
                </ul>
              </details>
            ) : null}
            <Button disabled={pending || ticked.length === 0 || conflicts.length > 0} onClick={apply}>
              Import {ticked.length} row{ticked.length === 1 ? "" : "s"}
            </Button>
          </section>
        </>
      ) : null}
    </div>
  );
}
