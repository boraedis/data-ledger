import "server-only";
import { cookies } from "next/headers";
import { PRIVACY_COOKIE, privacyFromCookie } from "@/lib/privacy/mode";

/**
 * Whether privacy mode is on for this request (#363). The one place the
 * server reads the cookie: pages, layouts and formatters ask here.
 */
export async function privacyMode(): Promise<boolean> {
  return privacyFromCookie((await cookies()).get(PRIVACY_COOKIE)?.value);
}
