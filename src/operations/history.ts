import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accounts, importMappings, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeMerchant } from "@/lib/categorize/merchant";
import { DATE_FORMATS, type Mapping } from "@/lib/history/csv";
import { INVESTMENT_KINDS } from "@/lib/investments/activity";
import { defineRead, defineWrite } from "@/operations/define";
import { NotFoundError } from "@/operations/tracked";

// History older than the sync reaches, from a bank's CSV export (#35): a
// one-time backfill, not a way of keeping the ledger current (the sync
// does that). The file is parsed in memory by the page
// (src/lib/history/csv.ts) and never stored; what reaches here is rows the
// owner has seen in a preview and confirmed.

// One file, one undoable command: a big export is split by year first.
export const MAX_IMPORT_ROWS = 5_000;

const column = z.number().int().min(0).max(200);
const mapping = z.object({
  skipRows: z.number().int().min(0).max(50),
  hasHeader: z.boolean(),
  date: column,
  dateFormat: z.enum(DATE_FORMATS),
  description: column,
  amount: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signed"), column, flip: z.boolean() }),
    z.object({ kind: z.literal("split"), debit: column, credit: column }),
  ]),
});

async function assertImportable(db: Db, accountId: string) {
  const [account] = await db.select({ type: accounts.type }).from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new NotFoundError("Account not found");
  // Brokerage exports are trades and positions, not a ledger: out of scope.
  if (INVESTMENT_KINDS.includes(account.type)) throw new Error("History import is for bank, card and loan accounts, not investment accounts");
}

export const getImportMapping = defineRead({
  name: "history.mapping",
  description: "The saved CSV column mapping for an account's history import, or null.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid() }),
  run: async (db, { accountId }) => {
    const [row] = await db.select({ mapping: importMappings.mapping }).from(importMappings).where(eq(importMappings.accountId, accountId));
    return row ? (row.mapping as Mapping) : null;
  },
});

export const saveImportMapping = defineWrite({
  name: "history.saveMapping",
  description: "Save how an account's bank lays out its CSV export: which columns hold the date, description and amount.",
  allowedActors: ["user"],
  input: z.object({ accountId: z.uuid(), mapping }),
  apply: async (ctx, { accountId, mapping }) => {
    await assertImportable(ctx.db, accountId);
    const [existing] = await ctx.db.select({ id: importMappings.id }).from(importMappings).where(eq(importMappings.accountId, accountId));
    if (existing) return ctx.update(importMappings, existing.id, { mapping, updatedAt: new Date() });
    return ctx.insert(importMappings, { accountId, mapping });
  },
});

export const importHistory = defineWrite({
  name: "history.import",
  description:
    "Backfill an account's older history from rows the owner confirmed from a CSV export. Marked as imported; a row " +
    "already imported (same ID) is skipped, so the same file twice adds nothing. One command, undone as a whole.",
  // The import page, after the owner confirms the preview.
  allowedActors: ["import"],
  input: z.object({
    accountId: z.uuid(),
    rows: z
      .array(
        z.object({
          postedOn: z.iso.date(),
          amountCents: z.number().int().refine((n) => n !== 0, "An amount can't be zero"),
          description: z.string().trim().min(1).max(500),
          externalId: z.string().regex(/^csv:/),
        }),
      )
      .min(1)
      .max(MAX_IMPORT_ROWS),
  }),
  apply: async (ctx, { accountId, rows }) => {
    await assertImportable(ctx.db, accountId);
    const ids = rows.map((r) => r.externalId);
    const existing = new Set(
      (
        await ctx.db
          .select({ externalId: transactions.externalId })
          .from(transactions)
          .where(and(eq(transactions.accountId, accountId), inArray(transactions.externalId, ids)))
      ).map((r) => r.externalId),
    );
    let inserted = 0;
    for (const r of rows) {
      if (existing.has(r.externalId)) continue;
      existing.add(r.externalId);
      await ctx.insert(transactions, {
        accountId,
        postedOn: r.postedOn,
        amountCents: r.amountCents,
        description: r.description,
        merchant: normalizeMerchant(r.description),
        externalId: r.externalId,
        source: "import",
      });
      inserted++;
    }
    return { inserted, alreadyImported: rows.length - inserted };
  },
});
