import { and, eq, gte, inArray } from "drizzle-orm";
import { dailyPrices, intradayPrices, quotes, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import { holdingsOn } from "@/lib/holdings/replay";
import type { NetWorthSummary } from "@/lib/net-worth";
import { HOURLY_DAYS } from "@/lib/prices/hourly";
import { OWNER_PRICE_SOURCE } from "@/lib/prices/owner";
import { manualClasses, MAX_CARRY_DAYS } from "@/lib/prices/rebuilt";
import { confirmedTrades } from "@/lib/trades/confirmed";

// Net worth by the hour (#338), for the short ranges of the Over time chart:
//
//   net worth(hour) = that day's net worth
//                   + Σ over coins held: quantity that day × (the hour's price − the day's price)
//
// So everything but crypto (cash, loans, stocks, funds, other assets) is
// its daily value, stepping at day boundaries: banks report no intraday
// balance, and stock prices are daily here (#243 is crypto only). The
// crypto in hand-entered accounts moves by the hour, from Coinbase's hourly
// closes. "The day's price" is the one the daily history valued it at (the
// day's close, carried like the replay carries it; today, the live quote),
// so a day's hours move around the daily point rather than redraw it.
//
// No guessing: an hour with no hourly close within HOUR_CARRY of it keeps
// the daily value. The newest hour is live net worth, so the chart ends on
// the page's number. Worked out when read, never stored, and not an
// operation: nothing here goes to a model.

const HOUR = 3_600_000;
// A coin's candle can be missing for an hour with no trades; carry the last close a few hours, no more.
const HOUR_CARRY = 3 * HOUR;
const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export type HourPoint = { at: string; cents: number };
export type HourlyNetWorth = { points: HourPoint[]; cryptoFrom: string | null };

type Close = { on: string; price: number; owner: boolean };

/** The price the daily history uses for a day: that day's close or the last within MAX_CARRY_DAYS, or the owner's latest earlier price. */
function dailyPriceOn(closes: Close[], day: string): number | null {
  let best: Close | null = null;
  for (const c of closes) if (c.on <= day) best = c;
  if (!best) return null;
  return best.owner || (Date.parse(day) - Date.parse(best.on)) / DAY <= MAX_CARRY_DAYS ? best.price : null;
}

export async function hourlyNetWorth(db: Db, summary: NetWorthSummary, { now = new Date() }: { now?: Date } = {}): Promise<HourlyNetWorth> {
  const net = new Map(summary.series.map((p) => [p.on, p.netCents]));
  const firstDay = summary.series[0]?.on;
  if (!firstDay) return { points: [], cryptoFrom: null };
  const currentHour = Math.floor(now.getTime() / HOUR) * HOUR;
  const start = Math.max(Math.floor((now.getTime() - HOURLY_DAYS * DAY) / HOUR) * HOUR, Date.parse(`${firstDay}T00:00:00Z`));
  const today = dayOf(now.getTime());

  // The coins in counted, hand-entered accounts (#231): excluded accounts stay excluded.
  const manual = summary.accounts.filter((a) => a.manual).map((a) => a.id);
  const classes = await manualClasses(db);
  const coinTrades = manual.length ? (await confirmedTrades(db, inArray(trades.accountId, manual))).filter((t) => (classes.get(`${t.accountId}:${t.symbol}`) ?? "crypto") === "crypto") : [];
  const symbols = [...new Set(coinTrades.map((t) => t.symbol))];

  const [dailyRows, hourRows, quoteRows] = symbols.length
    ? await Promise.all([
        db
          .select({ symbol: dailyPrices.symbol, on: dailyPrices.on, price: dailyPrices.price, source: dailyPrices.source })
          .from(dailyPrices)
          .where(and(eq(dailyPrices.assetClass, "crypto"), inArray(dailyPrices.symbol, symbols)))
          .orderBy(dailyPrices.on),
        db
          .select({ symbol: intradayPrices.symbol, hour: intradayPrices.hour, price: intradayPrices.price })
          .from(intradayPrices)
          .where(and(eq(intradayPrices.assetClass, "crypto"), inArray(intradayPrices.symbol, symbols), gte(intradayPrices.hour, new Date(start - HOUR_CARRY))))
          .orderBy(intradayPrices.hour),
        db.select({ symbol: quotes.symbol, price: quotes.price }).from(quotes).where(and(eq(quotes.assetClass, "crypto"), inArray(quotes.symbol, symbols))),
      ])
    : [[], [], []];
  const closes = new Map(symbols.map((s) => [s, dailyRows.filter((r) => r.symbol === s).map((r) => ({ on: r.on, price: Number(r.price), owner: r.source === OWNER_PRICE_SOURCE }))]));
  const hours = new Map(symbols.map((s) => [s, hourRows.filter((r) => r.symbol === s).map((r) => ({ t: r.hour.getTime(), price: Number(r.price) }))]));
  const quote = new Map(quoteRows.filter((q) => q.price !== null).map((q) => [q.symbol, Number(q.price)]));
  // Each coin's quantity across all its accounts, at the end of each day.
  const heldOn = (day: string) => holdingsOn(coinTrades, day);

  const cursor = new Map<string, number>();
  const hourPrice = (symbol: string, t: number): number | null => {
    const list = hours.get(symbol) ?? [];
    let i = cursor.get(symbol) ?? -1;
    while (i + 1 < list.length && list[i + 1].t <= t) i++;
    cursor.set(symbol, i);
    return i >= 0 && t - list[i].t <= HOUR_CARRY ? list[i].price : null;
  };

  const points: HourPoint[] = [];
  let heldDay = "";
  let held = new Map<string, string>();
  let carried = net.get(firstDay)!;
  for (let t = start; t <= currentHour; t += HOUR) {
    const day = dayOf(t);
    // A day missing from the daily series (it ends today) carries the last one, as the daily chart does.
    const base = net.get(day) ?? carried;
    carried = base;
    if (day !== heldDay) {
      held = heldOn(day);
      heldDay = day;
    }
    let delta = 0;
    for (const [symbol, quantity] of held) {
      const hourly = hourPrice(symbol, t);
      const daily = day === today ? (quote.get(symbol) ?? dailyPriceOn(closes.get(symbol) ?? [], day)) : dailyPriceOn(closes.get(symbol) ?? [], day);
      if (hourly !== null && daily !== null) delta += Number(quantity) * (hourly - daily) * 100;
    }
    points.push({ at: new Date(t).toISOString(), cents: base + Math.round(delta) });
  }
  // The newest hour is the page's number.
  if (points.length) points[points.length - 1] = { ...points.at(-1)!, cents: summary.netCents };
  const first = hourRows[0]?.hour;
  return { points, cryptoFrom: symbols.length && first ? first.toISOString() : null };
}
