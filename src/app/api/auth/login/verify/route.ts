import { NextResponse, type NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { startSession } from "@/lib/auth/session";
import { verifyAuthentication } from "@/lib/auth/webauthn";

const Body = z.object({
  response: z.looseObject({ id: z.string(), response: z.looseObject({}) }),
});

export async function POST(request: NextRequest) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const ok = await verifyAuthentication(
    request.url,
    body.data.response as unknown as AuthenticationResponseJSON,
  );
  if (!ok) return NextResponse.json({ error: "Sign-in failed" }, { status: 401 });

  await startSession();
  return NextResponse.json({ ok: true });
}
