import "server-only";
import { cookies } from "next/headers";
import { PRIVACY_COOKIE, privacyFromCookie } from "@/lib/privacy/mode";
import { setRequestPrivacy } from "@/lib/privacy/state";

/**
 * Whether privacy mode is on for this request (#363). The one place the
 * server reads the cookie. It also tells this request's formatting (#364),
 * so every page calls it before it renders: until one does, a Server
 * Component's figures are masked (lib/privacy/state.ts).
 */
export async function privacyMode(): Promise<boolean> {
  const on = privacyFromCookie((await cookies()).get(PRIVACY_COOKIE)?.value);
  setRequestPrivacy(on);
  return on;
}
