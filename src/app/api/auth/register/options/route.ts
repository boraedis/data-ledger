import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { registrationAccess } from "@/lib/auth/registration-access";
import { registrationOptions } from "@/lib/auth/webauthn";

const Body = z.object({ setupToken: z.string().optional() });

export async function POST(request: NextRequest) {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (!(await registrationAccess(body.data.setupToken))) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  return NextResponse.json(await registrationOptions(request.url));
}
