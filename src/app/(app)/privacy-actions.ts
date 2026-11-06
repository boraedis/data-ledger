"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { hasValidSession } from "@/lib/auth/session";
import { PRIVACY_COOKIE, PRIVACY_COOKIE_MAX_AGE } from "@/lib/privacy/mode";

/**
 * Turns privacy mode on or off in this browser (#363). Signed in only, like
 * every other action, though the cookie holds nothing secret. Every page is
 * rendered again, so what's on screen follows at once.
 */
export async function setPrivacyMode(on: boolean): Promise<{ error: string } | { on: boolean }> {
  if (!(await hasValidSession())) return { error: "Not signed in" };
  const jar = await cookies();
  if (on)
    jar.set(PRIVACY_COOKIE, "on", {
      // Read on the server only: client components get it from the layout.
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: PRIVACY_COOKIE_MAX_AGE,
    });
  else jar.delete(PRIVACY_COOKIE);
  revalidatePath("/", "layout");
  return { on };
}
