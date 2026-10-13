import { timingSafeEqual } from "crypto";

// The Diary bridge (#12) is called server-to-server by Data Diary, which
// has no session here. It gets its own token rather than reusing
// CRON_SECRET: a different caller with a different blast radius, and
// rotating one must never break the other.
//
// Too short or unset means the bridge is off — every request is refused,
// so a missing env var can't open it.
export const MIN_TOKEN_LENGTH = 32;

export function bridgeAuthorized(request: Request): boolean {
  const token = process.env.BRIDGE_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** JSON with headers every bridge response carries: never cached anywhere in between. */
export function bridgeJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const unauthorized = () => bridgeJson({ error: "Unauthorized" }, 401);
