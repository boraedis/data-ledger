import "server-only";
import { cookies } from "next/headers";
import { PRIVACY_COOKIE, privacyFromCookie, saltFromCookie } from "@/lib/privacy/mode";
import { setRequestPrivacy } from "@/lib/privacy/state";

/**
 * Whether privacy mode is on for this request (#363). The one place the
 * server reads the cookie. It also tells this request's formatting (#364),
 * so every page calls it before it renders: until one does, a Server
 * Component's figures are masked (lib/privacy/state.ts).
 */
export async function privacyMode(): Promise<boolean> {
  return (await privacyState()).on;
}

/** The mode and this browser's salt for name labels (#365), for the layout to hand the browser. */
export async function privacyState(): Promise<{ on: boolean; salt: string }> {
  const value = (await cookies()).get(PRIVACY_COOKIE)?.value;
  const state = { on: privacyFromCookie(value), salt: saltFromCookie(value) };
  setRequestPrivacy(state.on, state.salt);
  return state;
}
