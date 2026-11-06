"use server";

import { revalidatePath } from "next/cache";
import type { Db } from "@/db/types";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { readCsv } from "@/lib/history/csv";
import { refreshPricesAfterResponse } from "@/lib/prices/after-response";
import { actionKey, applyBrokerageMapping, distinctActions, guessActions, guessBrokerageMapping, quantitySigns, type ActionCategory, type BrokerageMapping } from "@/lib/trades/import-csv";
import { previewBrokerageImport } from "@/lib/trades/import-load";
import type { BaselineMove, PlannedRow } from "@/lib/trades/import-plan";
import { MAX_IMPORT_ROWS } from "@/operations/history";
import { execute, read } from "@/operations/runtime";
import { asOwner } from "@/operations/server";
import { tradeImportMapping } from "@/operations/trade-import";

// The brokerage import (#357), as the owner. As with the bank import (#35),
// the file's text arrives with each request, is read in memory and never
// stored: only the rows the owner ticks are written, by trades.import.

// Under the platform's 4.5 MB request limit, with room for the rest.
const MAX_FILE_CHARS = 4_000_000;

async function analyse(db: Db, accountId: string, text: string, given: BrokerageMapping | null) {
  if (text.length > MAX_FILE_CHARS) throw new Error("That file is too big for one import. Export a year at a time.");
  const grid = readCsv(text);
  if (grid.length === 0) throw new Error("That file has no rows.");
  const saved = given ? null : await read(db, tradeImportMapping, { accountId });
  const guessed = guessBrokerageMapping(grid);
  // A saved mapping keeps its columns and what it knew; an action it hasn't
  // seen is guessed, for the owner to confirm with the rest.
  const base = given ?? saved ?? guessed;
  const mapping: BrokerageMapping = { ...base, actions: { ...base.actions } };
  if (!given) Object.assign(mapping.actions, guessActions(grid, mapping, mapping.actions));
  const { rows, errors } = applyBrokerageMapping(grid, mapping);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`That file has ${rows.length} rows; one import takes up to ${MAX_IMPORT_ROWS}. Export a year at a time.`);
  return { grid, mapping, rows, errors };
}

export type PreviewRow = Pick<PlannedRow, "row" | "id" | "action" | "category" | "cash" | "trade" | "cashPlan" | "tradePlan" | "linkTo" | "ticked" | "warning">;

export type Preview = {
  mapping: BrokerageMapping;
  // The first rows as they are in the file, for mapping columns by eye.
  sample: string[][];
  // Each of the file's actions once, with how many rows have it and what it's mapped to.
  // `signs` is how many of its rows have a positive and a negative quantity, shown beside the by-sign meanings.
  actions: { key: string; rows: number; category: ActionCategory | null; signs: { positive: number; negative: number } }[];
  errors: { row: number; message: string }[];
  rows: PreviewRow[];
  reimported: number;
  baseline: BaselineMove | null;
};

/** What the file holds and what importing it would do. `ticked` is the owner's choice of rows, or null for the defaults. */
export async function previewTradeImport(accountId: string, text: string, mapping: BrokerageMapping | null, ticked: string[] | null): Promise<{ error: string } | Preview> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  try {
    const db = getDb();
    const a = await analyse(db, accountId, text, mapping);
    const plan = await previewBrokerageImport(db, accountId, a.rows, ticked ? new Set(ticked) : undefined);
    const signs = quantitySigns(a.grid, a.mapping);
    const counts = new Map<string, number>();
    for (const cells of a.grid.slice(a.mapping.skipRows + (a.mapping.hasHeader ? 1 : 0))) {
      const key = actionKey(cells[a.mapping.action] ?? "");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      mapping: a.mapping,
      sample: a.grid.slice(0, a.mapping.skipRows + 6),
      actions: distinctActions(a.grid, a.mapping).map((key) => ({ key, rows: counts.get(key) ?? 0, category: a.mapping.actions[key] ?? null, signs: signs.get(key) ?? { positive: 0, negative: 0 } })),
      errors: a.errors,
      rows: plan.rows
        .filter((r) => !r.reimported)
        .map(({ row, id, action, category, cash, trade, cashPlan, tradePlan, linkTo, warning, ticked: on }) => ({ row, id, action, category, cash, trade, cashPlan, tradePlan, linkTo, warning, ticked: ticked ? ticked.includes(id) : on })),
      reimported: plan.rows.filter((r) => r.reimported).length,
      baseline: plan.baseline,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't read that file" };
  }
}

export type Applied = { cashRows: number; trades: number; draftsFilled: number; skipped: number; baselineMovedTo: string | null };

/** Imports the ticked rows and saves the mapping for next time; then past prices are fetched for any new symbol. */
export async function applyTradeImport(accountId: string, text: string, mapping: BrokerageMapping, ticked: string[]): Promise<{ error: string } | Applied> {
  try {
    const result = await asOwner(async (db) => {
      const a = await analyse(db, accountId, text, mapping);
      const chosen = new Set(ticked);
      const rows = a.rows.filter((r) => chosen.has(r.id));
      await execute(db, { operation: "trades.saveImportMapping", input: { accountId, mapping: a.mapping }, actor: "user", reason: "Saved the brokerage export's layout for import" });
      if (rows.length === 0) return { cashRows: 0, trades: 0, draftsFilled: 0, skipped: 0, baselineMovedTo: null };
      const days = rows.map((r) => r.trade?.on ?? r.cash!.postedOn).sort();
      const out = await execute(db, {
        operation: "trades.import",
        input: { accountId, rows },
        actor: "import",
        reason: `Imported ${rows.length} row${rows.length === 1 ? "" : "s"} from a brokerage export (${days[0]} to ${days.at(-1)})`,
      });
      if (out.status !== "applied") throw new Error("The import wasn't applied");
      return out.output as Applied;
    });
    // Past prices for symbols new to the trade log (#232), once this is sent.
    refreshPricesAfterResponse();
    for (const path of ["/trades", "/transactions", "/accounts", "/net-worth", "/investments"]) revalidatePath(path);
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The import failed" };
  }
}
