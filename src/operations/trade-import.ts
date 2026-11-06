import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, importMappings, trades, transactions } from "@/db/schema";
import { DATE_FORMATS } from "@/lib/history/csv";
import { ACTION_CATEGORIES, type BrokerageMapping } from "@/lib/trades/import-csv";
import { previewBrokerageImport } from "@/lib/trades/import-load";
import { valueDate } from "@/operations/accounts";
import { defineRead, defineWrite } from "@/operations/define";
import { assetClassInput, decimal, symbol } from "@/operations/holdings";
import { followTrades, tradeAccount } from "@/operations/trades";
import { MAX_IMPORT_ROWS } from "@/operations/history";

// Importing a brokerage export (#356, epic #353): the rows the owner ticked
// on the preview, written as one command, so undo in Activity takes the
// whole import back. It plans again here (lib/trades/import-load.ts) rather
// than trusting the preview's plan: a sync between preview and apply could
// have added a cash row or a draft, and that's what counts.
//
// What it writes, per lib/trades/import-plan.ts:
// - cash rows the account doesn't have, marked imported, with the row's
//   stable ID as external ID;
// - trades, confirmed and marked imported, with the row's ID as their
//   import key, each linked to its cash row (its own new one, or the
//   synced one it matched when no other trade has that);
// - a waiting draft the file's trade is, filled in and confirmed;
// - the baseline moved back before the file, its openings shrunk by what
//   the file explains. A file that holds more than the account did on the
//   baseline day is refused, for the owner to untick those rows.
// Rows already there, sweeps into the cash fund and rows imported before
// are skipped, whatever was ticked.
//
// Never one of Tally's tools: the import page calls it after the owner
// confirms, as history.import, and trades are the owner's alone.

const cash = z.object({ postedOn: valueDate, amountCents: z.number().int().refine((n) => n !== 0, "An amount can't be zero"), description: z.string().trim().min(1).max(500) });
const trade = z.object({
  on: valueDate,
  kind: z.enum(["trade", "reinvestment", "split", "transfer", "fee"]),
  side: z.enum(["buy", "sell", "transfer_in", "transfer_out"]),
  symbol,
  quantity: decimal("Quantity"),
  price: decimal("Price").nullable(),
});
const row = z.object({
  row: z.number().int().min(1),
  id: z.string().regex(/^brk:/),
  action: z.string().max(500),
  category: z.enum(ACTION_CATEGORIES).exclude(["ignore"]),
  cash: cash.nullable(),
  trade: trade.nullable(),
});

const today = () => new Date().toISOString().slice(0, 10);

// How an account's brokerage lays out its export (#357), saved for next
// time in the same table as a bank's (#35): the bank import refuses
// investment accounts, so an account only ever has one kind.
const column = z.number().int().min(0).max(200);
const mapping = z.object({
  skipRows: z.number().int().min(0).max(50),
  hasHeader: z.boolean(),
  dateFormat: z.enum(DATE_FORMATS),
  date: column,
  settleDate: column.nullable(),
  action: column,
  symbol: column,
  quantity: column,
  price: column.nullable(),
  amount: column,
  description: column.nullable(),
  actions: z.record(z.string().max(200), z.enum(ACTION_CATEGORIES)),
});

export const tradeImportMapping = defineRead({
  name: "trades.importMapping",
  description: "The saved column and action mapping for an investment account's brokerage CSV import, or null. Owner only.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid() }),
  run: async (db, { accountId }) => {
    const [row] = await db.select({ mapping: importMappings.mapping }).from(importMappings).where(eq(importMappings.accountId, accountId));
    return row ? (row.mapping as BrokerageMapping) : null;
  },
});

export const saveTradeImportMapping = defineWrite({
  name: "trades.saveImportMapping",
  description: "Save how an investment account's brokerage lays out its CSV export: its columns, and what each of its actions means.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid(), mapping }),
  apply: async (ctx, { accountId, mapping }) => {
    await tradeAccount(ctx.db, accountId);
    const [existing] = await ctx.db.select({ id: importMappings.id }).from(importMappings).where(eq(importMappings.accountId, accountId));
    if (existing) return ctx.update(importMappings, existing.id, { mapping, updatedAt: new Date() });
    return ctx.insert(importMappings, { accountId, mapping });
  },
});

export const importTrades = defineWrite({
  name: "trades.import",
  description:
    "Import the rows the owner confirmed from a brokerage export into an investment account: new cash rows, confirmed trades linked " +
    "to their cash rows, drafts the file fills, and the trades baseline moved back when the file reaches before it. Rows already " +
    "there are skipped. One command, undone as a whole.",
  // The import page, after the owner confirms the preview.
  allowedActors: ["import"],
  input: z.object({
    accountId: z.uuid(),
    rows: z.array(row).min(1).max(MAX_IMPORT_ROWS),
    // For a manual account: the kind of asset a symbol new to it is.
    assetClass: assetClassInput.optional(),
    today: valueDate.optional(),
  }),
  apply: async (ctx, { accountId, rows, assetClass, today: on = today() }) => {
    const { drivesPositions } = await tradeAccount(ctx.db, accountId);
    const { rows: planned, baseline } = await previewBrokerageImport(ctx.db, accountId, rows, new Set(rows.map((r) => r.id)));
    if (baseline?.conflicts.length) {
      const c = baseline.conflicts[0];
      throw new Error(`The file has ${c.short} more ${c.symbol} on ${baseline.from} than the account held then. Untick those rows, or check the file`);
    }

    // The baseline first, so the replay never sees the openings and the file's trades counted together.
    if (baseline) {
      for (const id of baseline.removes) await ctx.remove(trades, id);
      for (const o of baseline.openings)
        await ctx.insert(trades, { accountId, on: baseline.to, symbol: o.symbol, side: o.side, quantity: o.quantity, price: null, status: "confirmed", source: "opening" });
      await ctx.update(accounts, accountId, { tradesBaselineOn: baseline.to });
    }

    const out = { cashRows: 0, trades: 0, draftsFilled: 0, skipped: 0, baselineMovedTo: baseline?.to ?? null };
    const symbols: string[] = [];
    for (const r of planned) {
      if (r.reimported) {
        out.skipped++;
        continue;
      }
      let cashId: string | null = null;
      if (r.cash && r.cashPlan?.status === "new") {
        // No merchant: a brokerage row has none by nature (#349), and linking
        // would make one for every fund's buys.
        const added = await ctx.insert(transactions, { accountId, postedOn: r.cash.postedOn, amountCents: r.cash.amountCents, description: r.cash.description, externalId: r.id, source: "import" });
        cashId = added.id;
        out.cashRows++;
      }
      const link = r.linkTo?.kind === "new" ? cashId : r.linkTo?.kind === "existing" ? r.linkTo.transactionId : null;
      const t = r.trade;
      if (t && r.tradePlan?.status === "new") {
        await ctx.insert(trades, { accountId, on: t.on, symbol: t.symbol, side: t.side, quantity: t.quantity, price: t.price, kind: t.kind, status: "confirmed", source: "import", importKey: r.id, transactionId: link });
        symbols.push(t.symbol);
        out.trades++;
      } else if (t && r.tradePlan?.status === "fills_draft") {
        const [draft] = await ctx.db.select().from(trades).where(eq(trades.id, r.tradePlan.draftId));
        await ctx.update(trades, draft.id, {
          on: t.on,
          onFrom: null,
          symbol: t.symbol,
          price: t.price ?? draft.price,
          kind: t.kind,
          status: "confirmed",
          importKey: r.id,
          // A cash row the owner already gave it stays.
          transactionId: draft.transactionId ?? link,
        });
        symbols.push(t.symbol);
        out.draftsFilled++;
      } else if (!(r.cash && r.cashPlan?.status === "new")) out.skipped++;
    }
    if (drivesPositions && symbols.length) await followTrades(ctx, accountId, symbols, on, assetClass ?? "equity");
    return out;
  },
});
