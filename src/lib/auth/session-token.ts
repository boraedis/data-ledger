import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

// Pure token logic, no database and no next/headers, so the proxy can import
// it. The proxy's check is only the fast first gate; the server re-checks the
// session row (see session.ts), which is what makes sign-out and revocation
// real. Next's own data-security guide warns against trusting the proxy alone.

export const SESSION_COOKIE_NAME = "dl_session";

// Twelve hours, absolute — not sliding. Long enough to get through a day of
// occasional use on one device, short enough that a forgotten session on a
// shared machine dies by morning. Data Diary's 30 days is fine for a journal
// and too long for bank data.
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  // 32 chars is a floor, not a recommendation; `openssl rand -base64 48`
  // is what the README suggests.
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET is not set (or shorter than 32 characters)");
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export type IssuedToken = { token: string; id: string; expiresAt: Date };

/** Cookie value is `<id>.<expiresAtMs>.<hmac>`. The id is random; the hmac stops forging or extending it. */
export function issueSessionToken(now = Date.now()): IssuedToken {
  const id = randomBytes(32).toString("base64url");
  const expiresAtMs = now + SESSION_TTL_SECONDS * 1000;
  const payload = `${id}.${expiresAtMs}`;
  return { token: `${payload}.${sign(payload)}`, id, expiresAt: new Date(expiresAtMs) };
}

/** Returns the session id if the token is well-formed, correctly signed and unexpired; otherwise null. */
export function readSessionToken(token: string | undefined | null, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expiresAtRaw, signature] = parts;

  const expected = Buffer.from(sign(`${id}.${expiresAtRaw}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;
  return id;
}
