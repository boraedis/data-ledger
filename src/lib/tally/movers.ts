// The investments part of Tally's daily summary (#214): how holdings moved
// since the snapshot before, and which moved a lot. Written as fixed text
// from the numbers here, never by the model: the model is never given
// holdings at all, so no value or balance can reach it, and a percentage
// it might misread is printed as computed.
//
// Moves are by price, not value: a position bought into or sold down
// changes in value without having moved. Price is value over shares, from
// each day's snapshot.

export type HoldingRow = { accountName: string; externalId: string; symbol: string | null; description: string; shares: string; marketValueCents: number };

export type Mover = { label: string; changePct: number };

export type InvestmentMoves = { from: string; to: string; changePct: number; movers: Mover[] };

// A day's move this size or more is called out. Broad index funds rarely
// move 5% in a day; a single stock that does is worth a look.
export const BIG_MOVE_PCT = 5;

const price = (r: HoldingRow) => {
  const shares = Number(r.shares);
  return shares > 0 ? r.marketValueCents / shares : null;
};

export function investmentMoves(before: { on: string; rows: HoldingRow[] }, after: { on: string; rows: HoldingRow[] }): InvestmentMoves | null {
  const earlier = new Map(before.rows.map((r) => [`${r.accountName}\u0000${r.externalId}`, r]));
  let was = 0;
  let now = 0;
  const movers: Mover[] = [];
  for (const r of after.rows) {
    const prev = earlier.get(`${r.accountName}\u0000${r.externalId}`);
    const p0 = prev && price(prev);
    const p1 = price(r);
    if (!prev || !p0 || p1 === null) continue;
    // The earlier day's position at today's price: the move with no buying or selling.
    was += prev.marketValueCents;
    now += Number(prev.shares) * p1;
    const changePct = (p1 / p0 - 1) * 100;
    if (Math.abs(changePct) >= BIG_MOVE_PCT) movers.push({ label: `${r.symbol ?? r.description} (${r.accountName})`, changePct });
  }
  if (was <= 0) return null;
  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return { from: before.on, to: after.on, changePct: (now / was - 1) * 100, movers };
}

const pct = (value: number) => `${value >= 0 ? "up" : "down"} ${Math.abs(value).toFixed(1)}%`;

/** A move as the summary words it: "up 1.2%", or "about flat" under a twentieth of a percent. */
export const moveText = (value: number) => (Math.abs(value) < 0.05 ? "about flat" : pct(value));

/** The summary's investments lines. */
export function investmentsText(moves: InvestmentMoves): string {
  const overall = moveText(moves.changePct);
  const lines = [`- Investments since ${moves.from}: holdings ${overall}.`];
  if (moves.movers.length) lines.push(`- Big movers: ${moves.movers.slice(0, 5).map((m) => `${m.label} ${pct(m.changePct)}`).join(", ")}.`);
  return lines.join("\n");
}
