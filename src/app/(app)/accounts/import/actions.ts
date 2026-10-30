"use server";

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { hasValidSession } from "@/lib/auth/session";
import { runCategorization } from "@/lib/categorize/pipeline";
import { getDb } from "@/lib/db";
import { OVERLAP_DAYS, applyMapping, findOverlaps, guessMapping, readCsv, type Mapping, type ParsedRow } from "@/lib/history/csv";
import { MAX_IMPORT_ROWS, getImportMapping } from "@/operations/history";
import { execute, read } from "@/operations/runtime";
import { asOwner } from "@/operations/server";

// History import (#35), as the owner. The file's text arrives with each
// request, is parsed in memory, and is never written anywhere: only the
// rows the owner confirms are, as transactions.

// Under the platform's 4.5 MB request limit, with room for the rest.
const MAX_FILE_CHARS = 4_000_000;

const shift = (on: string, days: number) => new Date(Date.parse(on) + days * 86_400_000).toISOString().slice(0, 10);

async function analyse(db: Db, accountId: string, text: string, given: Mapping | null) {
  if (text.length > MAX_FILE_CHARS) throw new Error("That file is too big for one import. Export a year at a time.");
  const grid = readCsv(text);
  if (grid.length === 0) throw new Error("That file has no rows.");
  const mapping = given ?? (await read(db, getImportMapping, { accountId })) ?? guessMapping(grid);
  const { rows, errors } = applyMapping(grid, mapping);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`That file has ${rows.length} rows; one import takes up to ${MAX_IMPORT_ROWS}. Export a year at a time.`);

  // Already imported: the same row from an earlier import of this file.
  const ids = rows.map((r) => r.externalId);
  const imported = new Set(
    ids.length
      ? (await db.select({ id: transactions.externalId }).from(transactions).where(and(eq(transactions.accountId, accountId), inArray(transactions.externalId, ids)))).map((r) => r.id)
      : [],
  );
  const fresh = rows.filter((r) => !imported.has(r.externalId));

  // Likely already here from the sync: compared only with synced rows (not
  // earlier imports, and not provisional ones that are replaced anyway).
  const dates = fresh.map((r) => r.postedOn).sort();
  const existing = dates.length
    ? await db
        .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents, description: transactions.description })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            gte(transactions.postedOn, shift(dates[0], -OVERLAP_DAYS)),
            lte(transactions.postedOn, shift(dates.at(-1)!, OVERLAP_DAYS)),
            or(isNull(transactions.source), sql`${transactions.source} <> 'import'`),
            isNull(transactions.provisionalSource),
          ),
        )
    : [];
  const overlaps = findOverlaps(fresh, existing);
  return { grid, mapping, rows, errors, imported, fresh, overlaps };
}

export type Preview = {
  mapping: Mapping;
  // The first rows as they are in the file, for mapping columns by eye.
  sample: string[][];
  parsed: number;
  alreadyImported: number;
  errors: { row: number; message: string }[];
  overlaps: { row: number; postedOn: string; amountCents: number; description: string; existing: { postedOn: string; description: string } }[];
  // What applying would add, before the owner un-skips any overlap.
  toAdd: { count: number; from: string | null; to: string | null; inCents: number; outCents: number };
};

export async function previewImport(accountId: string, text: string, mapping: Mapping | null): Promise<{ error: string } | Preview> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  try {
    const a = await analyse(getDb(), accountId, text, mapping);
    const adding = a.fresh.filter((r) => !a.overlaps.has(r.row));
    const dates = adding.map((r) => r.postedOn).sort();
    return {
      mapping: a.mapping,
      sample: a.grid.slice(0, a.mapping.skipRows + 6),
      parsed: a.rows.length,
      alreadyImported: a.imported.size,
      errors: a.errors,
      overlaps: [...a.overlaps].map(([row, e]) => {
        const r = a.rows.find((x) => x.row === row)!;
        return { row, postedOn: r.postedOn, amountCents: r.amountCents, description: r.description, existing: { postedOn: e.postedOn, description: e.description } };
      }),
      toAdd: {
        count: adding.length,
        from: dates[0] ?? null,
        to: dates.at(-1) ?? null,
        inCents: adding.filter((r) => r.amountCents > 0).reduce((s, r) => s + r.amountCents, 0),
        outCents: -adding.filter((r) => r.amountCents < 0).reduce((s, r) => s + r.amountCents, 0),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't read that file" };
  }
}

/**
 * Imports what the preview showed: every new row except likely overlaps,
 * plus any overlap the owner chose to keep. The mapping is saved for next
 * time; then rules and the transfer matcher run over what arrived.
 */
export async function applyImport(accountId: string, text: string, mapping: Mapping, keepOverlapRows: number[]): Promise<{ error: string } | { inserted: number; categorized: number }> {
  try {
    const result = await asOwner(async (db) => {
      const a = await analyse(db, accountId, text, mapping);
      const keep = new Set(keepOverlapRows);
      const rows: ParsedRow[] = a.fresh.filter((r) => !a.overlaps.has(r.row) || keep.has(r.row));
      await execute(db, { operation: "history.saveMapping", input: { accountId, mapping }, actor: "user", reason: "Saved the CSV layout for history import" });
      if (rows.length === 0) return { inserted: 0, categorized: 0 };
      const dates = rows.map((r) => r.postedOn).sort();
      const out = await execute(db, {
        operation: "history.import",
        input: { accountId, rows: rows.map(({ postedOn, amountCents, description, externalId }) => ({ postedOn, amountCents, description, externalId })) },
        actor: "import",
        reason: `Imported ${rows.length} transactions from a CSV export (${dates[0]} to ${dates.at(-1)})`,
      });
      const inserted = out.status === "applied" ? (out.output as { inserted: number }).inserted : 0;
      const categorized = (await runCategorization(db)).byRules;
      return { inserted, categorized };
    });
    revalidatePath("/transactions");
    revalidatePath("/inbox");
    revalidatePath("/accounts");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The import failed" };
  }
}
