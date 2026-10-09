import { createHash, randomBytes } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { apiTokens } from "@/db/schema";
import type { Db } from "@/db/types";

// Not "server-only": the MCP tests import this directly. It takes `db` as a
// parameter for the same reason, and to stay free of next/headers.

// The prefix makes a leaked token recognizable (and scannable) as ours.
const PREFIX = "dl_";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a token and returns it — the only time the plaintext exists anywhere. */
export async function createApiToken(db: Db, label: string): Promise<{ id: string; token: string }> {
  const token = PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db.insert(apiTokens).values({ label, tokenHash: hash(token) }).returning({ id: apiTokens.id });
  return { id: row.id, token };
}

/** The token's id if it exists and isn't revoked; otherwise null. Records the use. */
export async function verifyApiToken(db: Db, token: string | undefined | null): Promise<string | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const [row] = await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiTokens.tokenHash, hash(token)), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return row?.id ?? null;
}

export async function revokeApiToken(db: Db, id: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)));
}

export async function listApiTokens(db: Db) {
  return db
    .select({
      id: apiTokens.id,
      label: apiTokens.label,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .orderBy(desc(apiTokens.createdAt));
}
