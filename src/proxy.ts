import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, readSessionToken } from "@/lib/auth/session-token";

// Everything is gated unless listed here. Adding a route never makes it
// public by accident; making one public is a deliberate edit to this list.
// (Unlike Data Diary, there is no public site — nothing in Data Ledger is
// meant for anyone but the owner.)
const PUBLIC_PATHS = new Set(["/login"]);
const PUBLIC_PREFIXES = ["/api/auth/"];

/**
 * Production's canonical origin, if this request arrived anywhere else —
 * typically a deployment-specific *.vercel.app URL. Passkeys are bound to
 * the canonical domain, so sign-in can't work on those URLs; send people to
 * the one where it does instead of letting them hit the browser's error.
 * Previews are left alone: each one derives its passkey domain from its own
 * URL (src/lib/auth/webauthn.ts).
 */
function canonicalRedirect(request: NextRequest): URL | null {
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (process.env.VERCEL_ENV !== "production" || !origin) return null;
  const canonical = new URL(origin);
  if (request.nextUrl.host === canonical.host) return null;
  return new URL(request.nextUrl.pathname + request.nextUrl.search, canonical);
}

export function proxy(request: NextRequest) {
  const redirectTo = canonicalRedirect(request);
  // 307 keeps the method and body, so a POST to the old host (a passkey
  // request, a server action) follows through instead of becoming a GET.
  if (redirectTo) return NextResponse.redirect(redirectTo, 307);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  // Signature and expiry only — no database here. Pages re-check the
  // session row via requireOwner(), which is what honours sign-out.
  const signedIn = readSessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value) !== null;

  // No "/login → / when signed in" redirect here: a cookie can be validly
  // signed yet point at a session row that's gone (signed out elsewhere, DB
  // reset), and then "/" would bounce back to /login forever. The login page
  // makes that call itself, against the database.
  if (isPublic || signedIn) return NextResponse.next();

  // API callers get a status code, not an HTML login page they can't use.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
