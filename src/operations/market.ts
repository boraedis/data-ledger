import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dailyPrices, quotes } from "@/db/schema";
import { defineWrite } from "@/operations/define";

// Recording a refresh of market prices (#229) as one command: the whole
// batch, however many symbols, so Activity gets one line per refresh rather
// than one per quote (and hides even that by default). The prices are
// fetched before this runs (src/lib/prices/refresh.ts), outside the
// transaction, and arrive as its input. They're public prices for symbols;
// what the owner holds is never in it.
//
// Only the market actor runs it. There's no registered read of prices:
// every read is one of Tally's tools, and which symbols have prices says
// what the owner holds.

const result = z.union([
  z.object({ symbol: z.string().min(1).max(16), price: z.string().regex(/^\d+(\.\d+)?$/), asOf: z.iso.datetime() }),
  z.object({ symbol: z.string().min(1).max(16), price: z.null() }),
  z.object({ symbol: z.string().min(1).max(16), failed: z.literal(true) }),
]);

export const refreshQuotes = defineWrite({
  name: "market.refreshQuotes",
  description: "Record one refresh of market prices: each symbol's price from its source, no price, or a failed request.",
  allowedActors: ["market"],
  input: z.object({
    at: z.iso.datetime(),
    batches: z.array(z.object({ assetClass: z.enum(["crypto", "equity"]), source: z.string().min(1).max(40), results: z.array(result).max(200) })).min(1),
  }),
  apply: async (ctx, { at, batches }) => {
    const checkedAt = new Date(at);
    let priced = 0;
    let unpriced = 0;
    let failed = 0;
    for (const { assetClass, source, results } of batches) {
      for (const r of results) {
        const [existing] = await ctx.db
          .select({ id: quotes.id })
          .from(quotes)
          .where(and(eq(quotes.assetClass, assetClass), eq(quotes.symbol, r.symbol)));
        // A failed request only moves checkedAt: the last price stays, and
        // grows stale with its time showing, instead of being asked for on
        // every page view.
        const values =
          "failed" in r
            ? { checkedAt }
            : r.price === null
              ? { price: null, asOf: null, checkedAt, source }
              : { price: r.price, asOf: new Date(r.asOf), checkedAt, source };
        if (existing) await ctx.update(quotes, existing.id, values);
        else await ctx.insert(quotes, { assetClass, symbol: r.symbol, source, price: null, asOf: null, ...values });

        if ("failed" in r) failed++;
        else if (r.price === null) unpriced++;
        else {
          priced++;
          // The day's price for history (#232); a later refresh that day replaces it.
          const on = r.asOf.slice(0, 10);
          const [day] = await ctx.db
            .select({ id: dailyPrices.id })
            .from(dailyPrices)
            .where(and(eq(dailyPrices.assetClass, assetClass), eq(dailyPrices.symbol, r.symbol), eq(dailyPrices.on, on)));
          if (day) await ctx.update(dailyPrices, day.id, { price: r.price, source });
          else await ctx.insert(dailyPrices, { assetClass, symbol: r.symbol, on, price: r.price, source });
        }
      }
    }
    return { priced, unpriced, failed };
  },
});
