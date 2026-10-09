import { NextResponse, type NextRequest } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { registrationAccess } from "@/lib/auth/registration-access";
import { startSession } from "@/lib/auth/session";
import { verifyRegistration } from "@/lib/auth/webauthn";

// The credential's internals are validated by SimpleWebAuthn itself; this
// only checks the envelope so a malformed body fails as a 400, not a 500.
const Body = z.object({
  setupToken: z.string().optional(),
  label: z.string().trim().min(1).max(60),
  response: z.looseObject({ id: z.string(), response: z.looseObject({}) }),
});

export async function POST(request: NextRequest) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const access = await registrationAccess(body.data.setupToken);
  if (!access) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const ok = await verifyRegistration(
    request.url,
    body.data.response as unknown as RegistrationResponseJSON,
    body.data.label,
  );
  if (!ok) return NextResponse.json({ error: "Passkey could not be verified" }, { status: 400 });

  // Registering the very first passkey proves the owner is present, so sign
  // them straight in rather than making them use it a second time.
  if (access === "bootstrap") await startSession();
  return NextResponse.json({ ok: true });
}
