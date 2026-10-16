import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, unmappedWalletCards } from "@/db/schema";
import type { Db } from "@/db/types";
import { formatCents } from "@/lib/money";
import { execute } from "@/operations/runtime";

// An Apple Pay purchase from the iOS Shortcuts "Transaction" automation
// (#32): the merchant, the amount and the Wallet card's name, the moment
// the phone pays. It becomes a provisional transaction (#30) on the
// account that card is mapped to, and a push notification (#29). The bank's
// own record arrives with the next sync and replaces it.

export const purchaseBody = z.object({
  merchant: z.string().trim().min(1).max(200),
  // As the Shortcut sends it: a number, or text like "$12.34" or "12,34".
  amount: z.union([z.number(), z.string().trim().min(1).max(40)]),
  card: z.string().trim().min(1).max(100),
  // When the phone ran the automation (ISO 8601, from "Current Date").
  // Its date is the purchase's date in the owner's own time zone; without
  // it the server's (UTC) date is used, which can be a day ahead in the
  // evening. The matcher allows for that day either way.
  at: z.string().trim().max(40).optional(),
});
export type PurchaseBody = z.infer<typeof purchaseBody>;

/**
 * Cents from what the Shortcut sends. A purchase is money out, so the
 * result is negative; a leading minus (a refund to the card) makes it
 * positive. Accepts "$1,234.56", "1234.56", "1.234,56", "12,34", 12.34.
 * Null for anything else, rather than a guess.
 */
export function parseAmount(value: number | string): number | null {
  let text = (typeof value === "number" ? value.toFixed(2) : value).trim();
  const refund = /^[-−(]/.test(text);
  // A sign or parentheses, a currency symbol or code on either side, and
  // the number itself; anything else isn't an amount.
  text = text.replace(/^[-−(]\s*/, "").replace(/\)$/, "").replace(/^([$€£¥]|[A-Z]{3})\s*/, "").replace(/\s*([$€£¥]|[A-Z]{3})$/, "");
  if (!/^[\d.,]+$/.test(text)) return null;
  // The last separator followed by exactly one or two digits is the
  // decimal point; every other separator groups thousands, in threes.
  const decimal = text.match(/[.,](\d{1,2})$/);
  const wholeText = decimal ? text.slice(0, -decimal[0].length) : text;
  if (!/^(\d+|\d{1,3}([.,]\d{3})+)$/.test(wholeText) && wholeText !== "") return null;
  const whole = wholeText.replace(/[.,]/g, "");
  const cents = Number(whole || "0") * 100 + (decimal ? Number(decimal[1].padEnd(2, "0")) : 0);
  if (!Number.isSafeInteger(cents) || cents === 0) return null;
  return refund ? cents : -cents;
}

const today = () => new Date().toISOString().slice(0, 10);

export function purchaseDate(at: string | undefined): string {
  const date = at?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  return date && !Number.isNaN(Date.parse(date)) ? date : today();
}

export type PurchaseOutcome =
  | { status: "created" | "duplicate" | "already_synced"; transactionId: string; accountId: string; amountCents: number }
  | { status: "unmapped"; card: string }
  | { status: "invalid"; error: string };

export async function recordPurchase(db: Db, body: PurchaseBody, now = new Date()): Promise<PurchaseOutcome> {
  const amountCents = parseAmount(body.amount);
  if (amountCents === null) return { status: "invalid", error: "The amount wasn't a number of dollars and cents" };

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`lower(${accounts.walletCardName}) = lower(${body.card})`);
  if (!account) {
    // Remembered so Settings can offer it; the purchase itself isn't kept.
    await db
      .insert(unmappedWalletCards)
      .values({ name: body.card, lastSeenAt: now })
      .onConflictDoUpdate({ target: unmappedWalletCards.name, set: { lastSeenAt: now } });
    return { status: "unmapped", card: body.card };
  }

  // The Shortcut has no id of its own for a purchase, so one is derived
  // from what it sent, down to the minute: the same run posted twice is
  // recorded once, and two identical coffees a minute apart aren't.
  const moment = body.at ?? now.toISOString().slice(0, 16);
  const ref = createHash("sha256").update(`${body.card}|${body.merchant}|${amountCents}|${moment}`).digest("hex").slice(0, 32);

  const result = await execute(db, {
    operation: "transactions.createProvisional",
    actor: "alert",
    reason: "Apple Pay purchase",
    input: { accountId: account.id, postedOn: purchaseDate(body.at), amountCents, description: body.merchant, source: "apple_pay", ref },
  });
  const output = (result.status === "applied" ? result.output : null) as { status: "created" | "duplicate" | "already_synced"; transactionId: string } | null;
  if (!output) throw new Error(`Recording the purchase was ${result.status}`);
  return { ...output, accountId: account.id, amountCents };
}

/** The lock-screen text: merchant and amount, the card's name, nothing else. */
export function purchaseNotification(body: PurchaseBody, outcome: Extract<PurchaseOutcome, { transactionId: string }>) {
  return {
    title: `${body.merchant} · ${formatCents(Math.abs(outcome.amountCents))}${outcome.amountCents > 0 ? " refund" : ""}`,
    body: `${body.card} · tap to categorize`,
    // The quick-file screen (#34): file it in one tap.
    url: `/transactions/${outcome.transactionId}/quick`,
    tag: `purchase-${outcome.transactionId}`,
  };
}

export function unmappedNotification(card: string) {
  return {
    title: `New Wallet card: ${card}`,
    body: "Pick its account in Settings to get Apple Pay alerts for it.",
    url: "/settings#apple-pay",
    tag: `card-${card}`,
  };
}
