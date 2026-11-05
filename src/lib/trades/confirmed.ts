import { and, eq, type SQL } from "drizzle-orm";
import { trades } from "@/db/schema";
import type { Db } from "@/db/types";

// The one way to read the trades that count (#318): confirmed ones. Drafts
// and dismissed trades never move a position, a value or the history built
// from trades (#232). Every reader of the trade log goes through here, so
// none can forget the filter.

/** The where-clause for trades that count. */
export const isConfirmed = eq(trades.status, "confirmed");

export type ConfirmedTrade = Omit<typeof trades.$inferSelect, "symbol"> & { symbol: string };

/**
 * Confirmed trades, optionally narrowed further. A confirmed trade always has
 * a symbol and one day (the trades_confirmed_complete check), so the type
 * says so.
 */
export async function confirmedTrades(db: Db, where?: SQL): Promise<ConfirmedTrade[]> {
  const rows = await db
    .select()
    .from(trades)
    .where(where ? and(isConfirmed, where) : isConfirmed);
  return rows as ConfirmedTrade[];
}
