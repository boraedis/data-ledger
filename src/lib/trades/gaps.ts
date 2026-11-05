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

export type GapPosition = { key: string; symbol: string | null; externalId: string; shares: string; marketValueCents?: number };
export type TradeKind = "trade" | "reinvestment" | "split" | "transfer" | "fee";
export type GapTrade = { key: string; side: TradeSide; quantity: string; on: string };
export type PlannedTrade = {
  key: string;
  symbol: string | null;
  positionId: string | null;
  side: TradeSide;
  quantity: string;
  on: string;
  onFrom: string | null;
  kind: TradeKind;
  ratio: string | null;
  // Shared by the two ends of a share transfer (./plan.ts pairs them across accounts).
  pair?: string;
  // Set on a draft already waiting, offered for pairing with a new one: an
  // account synced a day before the other shouldn't miss its other end.
  existingId?: string;
};

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
export function planGaps({
  days,
  trades,
  baselineOn,
  remembered = () => undefined,
}: {
  days: { on: string; positions: GapPosition[] }[];
  trades: GapTrade[];
  baselineOn: string | null;
  /** The kind the owner said this position and side turned out to be last time (#324). */
  remembered?: (key: string, side: TradeSide) => TradeKind | undefined;
}): GapPlan {
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
      kind: "trade",
      ratio: null,
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
    const planned = asTrade(g.key, g.gap, g.position, latest.on, nextDay(agreed));
    // A split before anything else (#324): the shares multiply by a clean
    // ratio while the value barely moves. Drafted as a buy of the difference
    // it would distort the history built from trades in a way that's hard to see.
    const then = days.find((d) => d.on === agreed)?.positions.find((p) => p.key === g.key);
    const ratio = then && g.position ? splitRatio(then, g.position, replay(agreed).get(g.key) ?? "0") : null;
    if (ratio) return { ...planned, kind: "split" as const, ratio };
    const kind = remembered(g.key, planned.side);
    return kind && kind !== "split" && kind !== "transfer" ? { ...planned, kind } : planned;
  });
  return { baseline: null, drafts };
}

// The ratios a split comes in: forward and reverse.
const SPLIT_RATIOS = [2, 3, 4, 5, 10, 1.5, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 2 / 3];
/** How far the value may move across a split and still be one: markets move too. */
const SPLIT_VALUE_DRIFT = 0.15;

/**
 * A split's ratio, if going from `before` to `after` is one: the trades
 * explained the shares before (traded equals what was synced), the count
 * multiplied by a clean ratio, and the value stayed within a few percent.
 */
export function splitRatio(before: GapPosition, after: GapPosition, traded: string): string | null {
  const was = Number(before.shares);
  const now = Number(after.shares);
  if (!(was > 0) || Math.abs(Number(traded) - was) > 1e-9) return null;
  const r = now / was;
  const clean = SPLIT_RATIOS.find((x) => Math.abs(r / x - 1) < 1e-6);
  if (!clean) return null;
  if (before.marketValueCents === undefined || after.marketValueCents === undefined || !(before.marketValueCents > 0)) return null;
  if (Math.abs(after.marketValueCents / before.marketValueCents - 1) > SPLIT_VALUE_DRIFT) return null;
  return Number(clean.toFixed(6)).toString();
}

/** A day apart, either way, still overlaps: one account may see a move the day after the other. */
const TRANSFER_SLACK_DAYS = 3;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Shares moved between two of the owner's accounts (#324): a sale in one and
 * a buy in another of the same symbol and quantity, at overlapping times,
 * are one transfer, not a sale and a buy. Paired only where each is the
 * other's one fit, like cash transfers; the rest stay as they are.
 */
export function pairTransfers(plans: { accountId: string; drafts: PlannedTrade[] }[], waiting: { accountId: string; d: PlannedTrade }[] = []): void {
  const ends = [...plans.flatMap((p) => p.drafts.filter((d) => d.kind === "trade" && d.symbol).map((d) => ({ accountId: p.accountId, d }))), ...waiting];
  const overlap = (a: PlannedTrade, b: PlannedTrade) => shift(a.onFrom ?? a.on, -TRANSFER_SLACK_DAYS) <= b.on && shift(b.onFrom ?? b.on, -TRANSFER_SLACK_DAYS) <= a.on;
  const fits = (out: (typeof ends)[number], into: (typeof ends)[number]) =>
    out.d.side === "sell" && into.d.side === "buy" && out.accountId !== into.accountId && out.d.symbol === into.d.symbol && difference(out.d.quantity, into.d.quantity) === "0" && overlap(out.d, into.d);
  let n = 0;
  for (const out of ends) {
    const intos = ends.filter((x) => fits(out, x));
    if (intos.length !== 1 || ends.filter((x) => fits(x, intos[0])).length !== 1) continue;
    const into = intos[0];
    // Two drafts already waiting were left apart before, by the owner or a day's timing: not this run's to pair.
    if (out.d.existingId && into.d.existingId) continue;
    const pair = `t${++n}`;
    Object.assign(out.d, { kind: "transfer", side: "transfer_out", pair });
    Object.assign(into.d, { kind: "transfer", side: "transfer_in", pair });
  }
}
