import Link from "next/link";
import type { TradeRow } from "@/operations/trades";
import { draftHeadline } from "../../trades/fields";
import { StatusChip } from "../../trades/trade-item";

// On a brokerage cash row that settled a trade (#321, #351): which trade,
// in words, and a way to it on the Trades page, where it's edited or a
// draft finished. The row is the money; the trade is the shares, so it
// isn't spending and needs no merchant (#349).

export function TradeNote({ trade: t }: { trade: TradeRow }) {
  const params = new URLSearchParams({ account: t.accountId, ...(t.symbol ? { symbol: t.symbol } : {}) });
  // Drafts aren't filtered by date on the Trades page; the list is, so its link is to that day.
  if (t.status !== "draft") {
    params.set("from", t.onFrom ?? t.on);
    params.set("to", t.on);
  }
  const href = `/trades?${params}#${t.status === "draft" ? "drafts" : "all"}`;
  const headline = draftHeadline(t);
  return (
    <div className="space-y-1 rounded-lg border border-dashed p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Trade</span>
        <StatusChip status={t.status} />
      </p>
      <p>
        {headline.charAt(0).toUpperCase() + headline.slice(1)}
        {t.price ? ` at $${t.price} each` : ""}. This row is the cash side of it, so it isn&apos;t spending.{" "}
        <Link href={href} className="underline">
          {t.status === "draft" ? "Finish it on Trades" : "See it on Trades"}
        </Link>
      </p>
    </div>
  );
}
