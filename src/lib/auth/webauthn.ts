import "server-only";
import { timingSafeEqual } from "crypto";
import { and, count, eq, gt, lte } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { authChallenges, passkeys } from "@/db/schema";
import { getDb } from "@/lib/db";

const RP_NAME = "Data Ledger";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Every passkey belongs to the one owner, so they all share one fixed user
// handle. A random handle per registration would make a phone's password
// manager list each passkey as a separate account.
const OWNER_USER_ID = new TextEncoder().encode("data-ledger-owner");

type RelyingParty = { rpID: string; origin: string };

/**
 * Passkeys are bound to a domain (the RP ID), so this must be pinned in
 * production — a passkey registered against the wrong host is unusable.
 * Elsewhere (localhost, Vercel previews with their per-deploy hostnames,
 * each with its own synthetic database) it's derived from the request, so
 * previews work without per-deploy config.
 */
export function relyingParty(requestUrl: string): RelyingParty {
  const rpID = process.env.WEBAUTHN_RP_ID;
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (rpID && origin) return { rpID, origin };
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be set in production");
  }
  const url = new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

async function storeChallenge(challenge: string, purpose: "register" | "login") {
  const db = getDb();
  await db.delete(authChallenges).where(lte(authChallenges.expiresAt, new Date()));
  await db.insert(authChallenges).values({
    challenge,
    purpose,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

/** Deletes the challenge and reports whether it existed, was unexpired and had this purpose — so each one works exactly once. */
async function consumeChallenge(challenge: string, purpose: "register" | "login"): Promise<boolean> {
  const deleted = await getDb()
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.challenge, challenge),
        eq(authChallenges.purpose, purpose),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ challenge: authChallenges.challenge });
  return deleted.length === 1;
}

export async function ownerHasPasskey(): Promise<boolean> {
  const [{ value }] = await getDb().select({ value: count() }).from(passkeys);
  return value > 0;
}

/**
 * The first passkey has no session to authorize it, so it's gated by
 * OWNER_SETUP_TOKEN instead — and only while no passkey exists. Once the
 * owner has one, the token stops working and new passkeys need a session.
 * Without this, whoever reached a fresh deploy first would own it.
 */
export function setupTokenMatches(candidate: unknown): boolean {
  const expected = process.env.OWNER_SETUP_TOKEN;
  // A short token would be guessable against a fresh deploy, so one under 24
  // characters counts as not configured at all.
  if (!expected || expected.length < 24 || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registrationOptions(requestUrl: string) {
  const { rpID } = relyingParty(requestUrl);
  const existing = await getDb()
    .select({ id: passkeys.id, transports: passkeys.transports })
    .from(passkeys);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: OWNER_USER_ID,
    userName: "owner",
    userDisplayName: "Data Ledger owner",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: (p.transports ?? undefined) as AuthenticatorTransport[] | undefined,
    })),
    // Discoverable credentials so sign-in needs no username, and user
    // verification required so a passkey alone (without the device's
    // biometric or PIN) isn't enough.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await storeChallenge(options.challenge, "register");
  return options;
}

export async function verifyRegistration(
  requestUrl: string,
  response: RegistrationResponseJSON,
  label: string,
): Promise<boolean> {
  const { rpID, origin } = relyingParty(requestUrl);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: (challenge) => consumeChallenge(challenge, "register"),
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) return false;

  const { credential } = result.registrationInfo;
  await getDb().insert(passkeys).values({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? null,
    label,
  });
  return true;
}

export async function authenticationOptions(requestUrl: string) {
  const { rpID } = relyingParty(requestUrl);
  // Empty allowCredentials: the browser offers whichever discoverable
  // passkey it holds for this RP, and the server learns which from the response.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  await storeChallenge(options.challenge, "login");
  return options;
}

export async function verifyAuthentication(
  requestUrl: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const { rpID, origin } = relyingParty(requestUrl);
  const db = getDb();
  const [passkey] = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
  if (!passkey) return false;

  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: (challenge) => consumeChallenge(challenge, "login"),
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.id,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: (passkey.transports ?? undefined) as AuthenticatorTransport[] | undefined,
    },
  }).catch(() => null);
  if (!result?.verified) return false;

  await db
    .update(passkeys)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(passkeys.id, passkey.id));
  return true;
}

export async function listPasskeys() {
  return getDb()
    .select({ id: passkeys.id, label: passkeys.label, createdAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt })
    .from(passkeys)
    .orderBy(passkeys.createdAt);
}
