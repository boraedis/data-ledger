import "server-only";
import { and, eq, gt, lte } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessions } from "@/db/schema";
import { getDb } from "@/lib/db";
import {
  SESSION_COOKIE_NAME,
  hashSessionId,
  issueSessionToken,
  readSessionToken,
} from "@/lib/auth/session-token";

export async function startSession(): Promise<void> {
  const { token, id, expiresAt } = issueSessionToken();
  const db = getDb();
  // Opportunistic cleanup: one owner signing in a few times a day never
  // builds up enough rows to justify a scheduled job for this.
  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({ idHash: hashSessionId(id), expiresAt });

  (await cookies()).set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    // `secure` is off only for plain-http localhost, where browsers would
    // otherwise drop the cookie. WebAuthn itself refuses non-localhost http.
    secure: process.env.NODE_ENV === "production",
    // Strict, not Lax: nothing legitimately links into a signed-in page from
    // another site, and Strict closes off cross-site requests riding the
    // session entirely.
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

/** Whether the request carries a session that is signed, unexpired, and still present in the database. */
export async function hasValidSession(): Promise<boolean> {
  const id = readSessionToken((await cookies()).get(SESSION_COOKIE_NAME)?.value);
  if (!id) return false;
  const [row] = await getDb()
    .select({ idHash: sessions.idHash })
    .from(sessions)
    .where(and(eq(sessions.idHash, hashSessionId(id)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return Boolean(row);
}

/** For server components and pages: bounce to /login unless the owner is signed in. */
export async function requireOwner(): Promise<void> {
  if (!(await hasValidSession())) redirect("/login");
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const id = readSessionToken(jar.get(SESSION_COOKIE_NAME)?.value);
  if (id) await getDb().delete(sessions).where(eq(sessions.idHash, hashSessionId(id)));
  jar.delete(SESSION_COOKIE_NAME);
}
