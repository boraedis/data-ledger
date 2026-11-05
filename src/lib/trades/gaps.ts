import { difference, holdingsOn, type TradeSide } from "@/lib/holdings/replay";

// Drafting trades from gaps (#320): a share count the trade log doesn't
// explain is a trade that happened. One mechanism, replacing two ideas (a
// snapshot-to-snapshot difference, and #247's "doesn't add up" check):
//
//   gap = what the sync reports − what the account's trades replay to
//
// The replay counts confirmed trades, waiting drafts and dismissed ones.
// So a gap that has a draft isn't drafted again, confirming or editing a
// draft closes its own gap, and a gap the owner dismissed stays dismissed:
// running this twice does nothing the second time, with no bookkeeping of
// its own.
//
// Before any of that, each account gets a starting point (its baseline): on
// the first run, whatever its trades don't explain is recorded as opening
// trades, not drafts. Without one, every share held before the first logged
// trade would look like a gap, and the first sync after this shipped would
// flood the Trades page.
//
// Pure: lib/trades/plan.ts loads the rows and the trades.draftGaps operation
// writes what this returns.

/** What a position is matched by: its symbol, or the provider's id for one without. */
export const positionKey = (p: { symbol: string | null; externalId: string }) => (p.symbol ? p.symbol.toUpperCase() : `id:${p.externalId}`);

/**
 * What a trade is matched by. A trade with a positionId came from a
 * position with no symbol, and stays matched to it even once the owner
 * names it, or the position would look like a new gap.
 */
export const tradeKey = (t: { symbol: string | null; positionId: string | null }) => (t.positionId ? `id:${t.positionId}` : t.symbol!);

export type GapPosition = { key: string; symbol: string | null; externalId: string; shares: string };
export type GapTrade = { key: string; side: TradeSide; quantity: string; on: string };
export type PlannedTrade = { key: string; symbol: string | null; positionId: string | null; side: TradeSide; quantity: string; on: string; onFrom: string | null };

export type GapPlan = {
  /** The baseline to record, with its opening trades, when the account has none yet. */
  baseline: { on: string; opening: PlannedTrade[] } | null;
  /** New drafts, one per gap. */
  drafts: PlannedTrade[];
};

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The plan for one account.
 *
 * - `days`: the account's snapshot days, oldest first, each with its non-cash
 *   positions (cash is left out by the caller, lib/trades/cash.ts).
 * - `trades`: every trade in the account that counts for gaps: confirmed,
 *   draft and dismissed, keyed with tradeKey.
 * - `baselineOn`: the account's baseline, or null before its first run.
 */
export function planGaps({ days, trades, baselineOn }: { days: { on: string; positions: GapPosition[] }[]; trades: GapTrade[]; baselineOn: string | null }): GapPlan {
  const latest = days.at(-1);
  if (!latest) return { baseline: null, drafts: [] };
  const replay = (on: string, extra: GapTrade[] = []) => holdingsOn([...trades, ...extra].map((t) => ({ ...t, symbol: t.key })), on);
  const reported = (positions: GapPosition[]) => new Map(positions.map((p) => [p.key, p]));

  // What the sync says minus what the trades say, for each position on a day.
  const gaps = (day: { on: string; positions: GapPosition[] }, extra: GapTrade[] = []) => {
    const synced = reported(day.positions);
    const traded = replay(day.on, extra);
    const out: { key: string; gap: string; position?: GapPosition }[] = [];
    for (const key of new Set([...synced.keys(), ...traded.keys()])) {
      const gap = difference(synced.get(key)?.shares ?? "0", traded.get(key) ?? "0");
      if (gap !== "0") out.push({ key, gap, position: synced.get(key) });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  };
  const asTrade = (key: string, gap: string, position: GapPosition | undefined, on: string, onFrom: string | null): PlannedTrade => {
    const selling = gap.startsWith("-");
    const symbol = position?.symbol?.toUpperCase() ?? (key.startsWith("id:") ? null : key);
    return {
      key,
      symbol,
      positionId: key.startsWith("id:") ? key.slice(3) : null,
      side: selling ? "sell" : "buy",
      quantity: selling ? gap.slice(1) : gap,
      on,
      onFrom: onFrom && onFrom < on ? onFrom : null,
    };
  };

  // First run: everything unexplained today is where the account starts.
  if (!baselineOn) {
    return { baseline: { on: latest.on, opening: gaps(latest).map((g) => asTrade(g.key, g.gap, g.position, latest.on, null)) }, drafts: [] };
  }
  if (latest.on <= baselineOn) return { baseline: null, drafts: [] };

  // Each gap since: a draft dated from the day after the last snapshot where
  // the trades agreed with the sync for that position, up to today.
  const since = days.filter((d) => d.on >= baselineOn);
  const drafts = gaps(latest).map((g) => {
    let agreed = baselineOn;
    for (const day of [...since].reverse()) {
      if (day.on >= latest.on) continue;
      if (!gaps(day).some((x) => x.key === g.key)) {
        agreed = day.on;
        break;
      }
    }
    return asTrade(g.key, g.gap, g.position, latest.on, nextDay(agreed));
  });
  return { baseline: null, drafts };
}
