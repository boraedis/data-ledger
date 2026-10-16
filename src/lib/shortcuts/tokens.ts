import { createHash, randomBytes } from "crypto";
import { desc, eq, sql } from "drizzle-orm";
import { shortcutTokens, unmappedWalletCards } from "@/db/schema";
import type { Db } from "@/db/types";

// Tokens for the Apple Pay Shortcut (#32), and the Wallet card names it
// sent before they were mapped. Tokens are one per device, shown once when
// created, stored only as a SHA-256. A token is 32 random bytes, so a
// plain hash is enough (no salt or slow hash needed: there's nothing to
// guess). Lookups go by hash, so the token itself is never compared.

const PREFIX = "dlsc_";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createToken(db: Db, label: string): Promise<{ id: string; token: string }> {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db.insert(shortcutTokens).values({ label, tokenHash: hashToken(token) }).returning({ id: shortcutTokens.id });
  return { id: row.id, token };
}

/** The token's row if the bearer header carries a live token, and records the use. */
export async function verifyBearer(db: Db, authorization: string | null): Promise<{ id: string; label: string } | null> {
  const token = authorization?.match(/^Bearer (dlsc_[A-Za-z0-9_-]{20,100})$/)?.[1];
  if (!token) return null;
  const [row] = await db
    .update(shortcutTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(shortcutTokens.tokenHash, hashToken(token)))
    .returning({ id: shortcutTokens.id, label: shortcutTokens.label });
  return row ?? null;
}

export async function listTokens(db: Db) {
  return db
    .select({ id: shortcutTokens.id, label: shortcutTokens.label, createdAt: shortcutTokens.createdAt, lastUsedAt: shortcutTokens.lastUsedAt })
    .from(shortcutTokens)
    .orderBy(desc(shortcutTokens.createdAt));
}

export async function revokeToken(db: Db, id: string) {
  await db.delete(shortcutTokens).where(eq(shortcutTokens.id, id));
}

export async function listUnmappedCards(db: Db) {
  return db.select().from(unmappedWalletCards).orderBy(desc(unmappedWalletCards.lastSeenAt));
}

/** Once a name is mapped (or the owner dismisses it), it's no longer offered. */
export async function forgetUnmappedCard(db: Db, name: string) {
  await db.delete(unmappedWalletCards).where(sql`lower(${unmappedWalletCards.name}) = lower(${name})`);
}
