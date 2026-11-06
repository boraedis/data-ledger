import { findOverlaps, OVERLAP_DAYS, type Existing } from "@/lib/history/csv";
import { difference, type TradeSide } from "@/lib/holdings/replay";
import type { BrokerageRow, ImportedTrade } from "@/lib/trades/import-csv";

// What a brokerage import would do, against what's already in the account
// (#355, epic #353): for each file row, whether its cash and its shares are
// new, already there, or fill a draft; and how the account's starting point
// (its trades baseline, #320) moves when the file reaches further back.
// Pure: ./import-load.ts reads the account, the preview shows this, and
// trades.import (#356) writes what the owner ticked.
//
// Nothing is merged or overwritten here. A row that looks like it's already
// there is unticked for the owner to see, never dropped.

export type ExistingTrade = {
  id: string;
  symbol: string | null;
  side: TradeSide;
  quantity: string;
  on: string;
  onFrom: string | null;
  status: "draft" | "confirmed" | "dismissed";
  source: "hand" | "opening" | "position_gap" | string;
  transactionId: string | null;
};

export type CashPlan =
  // A new cash row.
  | { status: "new" }
  // The sync (or an earlier import) already has it: not added, and the
  // row's trade links to that one instead.
  | { status: "already"; existingId: string };

export type TradePlan =
  | { status: "new" }
  // A draft from a position gap that this trade is (#320): it's filled in
  // with the file's day, price and cash row and confirmed, not added
  // beside it. A dismissed draft would still count for gaps, so dismissing
  // it and adding a new trade would draft the shares again.
  | { status: "fills_draft"; draftId: string }
  // A confirmed trade (or one the owner dismissed) with the same symbol,
  // side and quantity a few days either side: not added.
  | { status: "already"; tradeId: string; dismissed: boolean }
  // Shares of the account's own cash fund (a sweep): not a trade (#316).
  | { status: "cash_fund" };

export type PlannedRow = BrokerageRow & {
  // Imported before, by its stable ID: left out of the preview entirely.
  reimported: boolean;
  cashPlan: CashPlan | null;
  tradePlan: TradePlan | null;
  // The cash row this row's trade settles through: its own new one, or the
  // existing one it matched. Null when it has none, or the existing one is
  // already another trade's (one trade per cash row, #321).
  linkTo: { kind: "new" } | { kind: "existing"; transactionId: string } | null;
  // What the preview ticks to start with: anything that adds something,
  // unless the reader flagged the row (BrokerageRow.warning).
  ticked: boolean;
};

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const signedQty = (t: { side: TradeSide; quantity: string }) => (t.side === "sell" || t.side === "transfer_out" ? `-${t.quantity}` : t.quantity);
// a + b, exactly, through replay's a − b.
const plus = (a: string, b: string) => difference(a, b.startsWith("-") ? b.slice(1) : `-${b}`);

/**
 * Each row's plan.
 *
 * - `importedIds`: stable IDs already imported into the account.
 * - `existingCash`: the account's transactions, with whether a trade has each.
 * - `trades`: every trade in the account (drafts, confirmed, dismissed).
 * - `cashFunds`: symbols the account holds as cash (lib/trades/cash.ts).
 */
export function planImport({
  rows,
  importedIds,
  existingCash,
  trades,
  cashFunds,
}: {
  rows: BrokerageRow[];
  importedIds: Set<string>;
  existingCash: (Existing & { hasTrade: boolean })[];
  trades: ExistingTrade[];
  cashFunds: Set<string>;
}): PlannedRow[] {
  const fresh = rows.filter((r) => !importedIds.has(r.id));
  // Cash: the bank import's matcher, on the same terms (exact amount within
  // a few days), against rows not imported by an earlier run of this file.
  const cashRows = fresh.flatMap((r) => (r.cash ? [{ row: r.row, postedOn: r.cash.postedOn, amountCents: r.cash.amountCents, description: r.cash.description, externalId: r.id }] : []));
  const overlaps = findOverlaps(cashRows, existingCash);
  const taken = new Map(existingCash.map((e) => [e.id, e.hasTrade]));

  // Trades: each existing trade answers for one file row at most, nearest day first.
  const claimed = new Set<string>();
  const matchTrade = (t: ImportedTrade): TradePlan => {
    if (cashFunds.has(t.symbol)) return { status: "cash_fund" };
    const same = trades.filter((x) => !claimed.has(x.id) && x.symbol === t.symbol && x.side === t.side && x.quantity === t.quantity && x.source !== "opening");
    // A draft knows the range its day falls in; the file's day should be in it, give or take a settlement.
    const draft = same
      .filter((x) => x.status === "draft" && t.on >= addDays(x.onFrom ?? x.on, -OVERLAP_DAYS) && t.on <= addDays(x.on, OVERLAP_DAYS))
      .sort((a, b) => days(a.on, t.on) - days(b.on, t.on))[0];
    if (draft) {
      claimed.add(draft.id);
      return { status: "fills_draft", draftId: draft.id };
    }
    const done = same.filter((x) => x.status !== "draft" && days(x.on, t.on) <= OVERLAP_DAYS).sort((a, b) => days(a.on, t.on) - days(b.on, t.on))[0];
    if (done) {
      claimed.add(done.id);
      return { status: "already", tradeId: done.id, dismissed: done.status === "dismissed" };
    }
    return { status: "new" };
  };

  return [...rows]
    .sort((a, b) => (a.trade?.on ?? a.cash!.postedOn).localeCompare(b.trade?.on ?? b.cash!.postedOn) || a.row - b.row)
    .map((r) => {
      if (importedIds.has(r.id)) return { ...r, reimported: true, cashPlan: null, tradePlan: null, linkTo: null, ticked: false };
      const match = overlaps.get(r.row);
      const cashPlan: CashPlan | null = r.cash ? (match ? { status: "already", existingId: match.id } : { status: "new" }) : null;
      const tradePlan = r.trade ? matchTrade(r.trade) : null;
      const linkTo: PlannedRow["linkTo"] =
        !tradePlan || !cashPlan || tradePlan.status === "cash_fund" || tradePlan.status === "already"
          ? null
          : cashPlan.status === "new"
            ? { kind: "new" }
            : taken.get(cashPlan.existingId)
              ? null
              : { kind: "existing", transactionId: cashPlan.existingId };
      const adds = cashPlan?.status === "new" || tradePlan?.status === "new" || tradePlan?.status === "fills_draft";
      // A row the reader had doubts about (its quantity and its cash disagree
      // about which way it went) adds something but waits for the owner's tick.
      return { ...r, reimported: false, cashPlan, tradePlan, linkTo, ticked: adds && !r.warning };
    })
    .sort((a, b) => a.row - b.row);
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// --- The baseline -----------------------------------------------------------------

export type Opening = { id: string; symbol: string; side: TradeSide; quantity: string };

export type BaselineMove = {
  // The account's baseline now, and where it moves: the day before the
  // file's first trade, so the openings come first on that day's replay.
  from: string;
  to: string;
  // Each symbol's opening at the new baseline: what it was minus what the
  // imported trades up to the old baseline add. Zero removes the opening;
  // a symbol with no opening before gets one if the file sells it.
  openings: { symbol: string; side: "buy"; quantity: string }[];
  // The openings replaced: removed, with the new ones in their place.
  removes: string[];
  // Symbols where the file holds more on the old baseline than the account
  // did then: the file and the sync disagree. Those rows aren't imported
  // until the owner unticks them or fixes the openings.
  conflicts: { symbol: string; short: string }[];
};

/**
 * How the baseline moves when an import reaches before it (#355).
 *
 * The openings are the shares the account held on its baseline day that no
 * trade explained. A trade imported on or before that day is now one that
 * explains some of them, so the openings shrink by what those trades add
 * and move back to before the first of them. Holdings on every day from
 * the old baseline on, today's included, come out the same.
 *
 * Null when nothing reaches back: no baseline yet (the first gap run sets
 * one, counting the imported trades), or every trade is after it.
 */
export function moveBaseline({
  baselineOn,
  openings,
  imported,
}: {
  baselineOn: string | null;
  openings: Opening[];
  imported: Pick<ImportedTrade, "on" | "symbol" | "side" | "quantity">[];
}): BaselineMove | null {
  if (!baselineOn) return null;
  const before = imported.filter((t) => t.on <= baselineOn);
  if (!before.length) return null;
  const first = before.map((t) => t.on).sort()[0];
  const total = (list: { symbol: string; side: TradeSide; quantity: string }[]) => {
    const sums = new Map<string, string>();
    for (const t of list) sums.set(t.symbol, plus(sums.get(t.symbol) ?? "0", signedQty(t)));
    return sums;
  };
  const net = total(before);
  const opened = total(openings);

  const move: BaselineMove = { from: baselineOn, to: addDays(first, -1), openings: [], removes: [], conflicts: [] };
  // Only the symbols the file trades before the baseline: another symbol's
  // opening stays where it is, as nothing new is known about it.
  for (const symbol of [...net.keys()].sort()) {
    const left = difference(opened.get(symbol) ?? "0", net.get(symbol)!);
    if (left.startsWith("-")) {
      move.conflicts.push({ symbol, short: left.slice(1) });
      continue;
    }
    move.removes.push(...openings.filter((o) => o.symbol === symbol).map((o) => o.id));
    if (left !== "0") move.openings.push({ symbol, side: "buy", quantity: left });
  }
  return move;
}
