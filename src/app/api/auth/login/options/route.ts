import { NextResponse, type NextRequest } from "next/server";
import { authenticationOptions } from "@/lib/auth/webauthn";

export async function POST(request: NextRequest) {
  return NextResponse.json(await authenticationOptions(request.url));
}
