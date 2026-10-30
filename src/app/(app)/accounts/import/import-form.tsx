"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DATE_FORMATS, type DateFormat, type Mapping } from "@/lib/history/csv";
import { formatCents } from "@/lib/money";
import { applyImport, previewImport, type Preview } from "./actions";

// The import's steps on one screen: pick the account and file; check the
// columns (guessed, or as saved for this account); see what would be added
// and what looks like it's already here; then apply.

const select = "h-9 rounded-md border bg-background px-2 text-sm";
const MAX_ERRORS = 20;

export function ImportForm({ accounts, initialAccountId }: { accounts: { id: string; name: string }[]; initialAccountId: string }) {
  const [accountId, setAccountId] = useState(initialAccountId);
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = (account: string, content: string, mapping: Mapping | null) =>
    startTransition(async () => {
      setError(null);
      setDone(null);
      const result = await previewImport(account, content, mapping);
      if ("error" in result) {
        setPreview(null);
        setError(result.error);
      } else {
        setPreview(result);
        setKeep(new Set());
      }
    });

  const remap = (patch: Partial<Mapping>) => preview && text && load(accountId, text, { ...preview.mapping, ...patch });
  const header = preview ? (preview.sample[preview.mapping.skipRows] ?? []) : [];
  const columns = header.map((h, i) => ({ i, label: preview?.mapping.hasHeader && h.trim() ? `${i + 1}: ${h}` : `Column ${i + 1}` }));
  const columnPicker = (value: number, onChange: (v: number) => void, label: string) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select className={select} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {columns.map((c) => (
          <option key={c.i} value={c.i}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );

  const apply = () =>
    startTransition(async () => {
      if (!preview || !text) return;
      const result = await applyImport(accountId, text, preview.mapping, [...keep]);
      if ("error" in result) setError(result.error);
      else {
        // The rules run over everything waiting, not only this file's rows.
        setDone(`Imported ${result.inserted} transaction${result.inserted === 1 ? "" : "s"}${result.categorized ? `, then ran your rules (${result.categorized} filed across everything waiting)` : ""}.`);
        setPreview(null);
        setText(null);
        setFileName("");
      }
    });

  const adding = preview ? preview.toAdd.count + keep.size : 0;

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
              // The saved mapping is per account: read the file again under it.
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
          {done}{" "}
          <Link href={`/transactions?account=${accountId}`} className="underline">
            See them
          </Link>{" "}
          · uncategorized ones are in the{" "}
          <Link href="/inbox" className="underline">
            Inbox
          </Link>
          .
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
              {columnPicker(preview.mapping.date, (v) => remap({ date: v }), "Date")}
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
              {columnPicker(preview.mapping.description, (v) => remap({ description: v }), "Description")}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Amount
                <select
                  className={select}
                  value={preview.mapping.amount.kind}
                  onChange={(e) =>
                    remap({
                      amount: e.target.value === "split" ? { kind: "split", debit: 0, credit: Math.min(1, columns.length - 1) } : { kind: "signed", column: 0, flip: false },
                    })
                  }
                >
                  <option value="signed">One column, signed</option>
                  <option value="split">Separate money out / in</option>
                </select>
              </label>
              {preview.mapping.amount.kind === "signed" ? (
                <>
                  {columnPicker(preview.mapping.amount.column, (v) => remap({ amount: { kind: "signed", column: v, flip: preview.mapping.amount.kind === "signed" && preview.mapping.amount.flip } }), "Amount column")}
                  <label className="flex items-center gap-2 pb-2 text-xs">
                    <input
                      type="checkbox"
                      checked={preview.mapping.amount.flip}
                      onChange={(e) => preview.mapping.amount.kind === "signed" && remap({ amount: { ...preview.mapping.amount, flip: e.target.checked } })}
                    />
                    Purchases are positive (some card exports)
                  </label>
                </>
              ) : (
                <>
                  {columnPicker(preview.mapping.amount.debit, (v) => preview.mapping.amount.kind === "split" && remap({ amount: { ...preview.mapping.amount, debit: v } }), "Money out")}
                  {columnPicker(preview.mapping.amount.credit, (v) => preview.mapping.amount.kind === "split" && remap({ amount: { ...preview.mapping.amount, credit: v } }), "Money in")}
                </>
              )}
            </div>
          </section>

          <section className="space-y-2 rounded-lg border p-3">
            <h2 className="font-medium">What this adds</h2>
            <p>
              {preview.parsed} row{preview.parsed === 1 ? "" : "s"} read
              {preview.toAdd.from ? `, ${preview.toAdd.from} to ${preview.toAdd.to}` : ""}.{" "}
              <strong>{adding}</strong> to add: {formatCents(preview.toAdd.outCents)} out, {formatCents(preview.toAdd.inCents)} in
              {keep.size ? " (before the overlaps you're keeping)" : ""}.
              {preview.alreadyImported ? ` ${preview.alreadyImported} already imported from this file before; skipped.` : ""}
            </p>
            {preview.overlaps.length ? (
              <details className="rounded-md border border-dashed p-2" open={preview.overlaps.length <= 10}>
                <summary className="cursor-pointer">
                  {preview.overlaps.length} look{preview.overlaps.length === 1 ? "s" : ""} already here from the sync, so {preview.overlaps.length === 1 ? "it's" : "they're"} skipped
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">
                  Same amount within 3 days of one the sync already has. Tick one to import it anyway (two real purchases of the same amount, say).
                </p>
                <ul className="mt-2 divide-y text-xs">
                  {preview.overlaps.map((o) => (
                    <li key={o.row} className="flex items-start gap-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Import row ${o.row} anyway`}
                        checked={keep.has(o.row)}
                        onChange={(e) => {
                          const next = new Set(keep);
                          if (e.target.checked) next.add(o.row);
                          else next.delete(o.row);
                          setKeep(next);
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          Row {o.row} · {o.postedOn} · {o.description}
                        </span>
                        <span className="block truncate text-muted-foreground">
                          Already here: {o.existing.postedOn} · {o.existing.description}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatCents(o.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
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
            <Button disabled={pending || adding === 0} onClick={apply}>
              Import {adding} transaction{adding === 1 ? "" : "s"}
            </Button>
          </section>
        </>
      ) : null}
    </div>
  );
}
